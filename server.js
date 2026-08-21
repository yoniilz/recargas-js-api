const express = require("express");
const cors = require("cors");

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(cors({ origin: "*", methods: ["GET", "POST", "PATCH", "DELETE"] }));

const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const SIXOFF_API_KEY = process.env.SIXOFF_API_KEY || "";
const SIXOFF_BASE_URL = "https://api.sixofire.net";

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || "";

const sentOrders = new Map();
const sendingOrders = new Set();
const createRate = new Map();

function requireAdmin(req, res, next) {
  const secret = req.get("x-admin-secret");
  if (!ADMIN_SECRET) {
    return res.status(503).json({ ok:false, error:"ADMIN_SECRET no configurado." });
  }
  if (secret !== ADMIN_SECRET) {
    return res.status(401).json({ ok:false, error:"No autorizado." });
  }
  next();
}

function requireSixo(req, res, next) {
  if (!SIXOFF_API_KEY) {
    return res.status(503).json({ ok:false, error:"SIXOFF_API_KEY no configurada." });
  }
  next();
}

function requireSupabase(req, res, next) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    return res.status(503).json({ ok:false, error:"Supabase no está configurado en Render." });
  }
  next();
}

function normalizePrice(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = String(value || "").replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

function makeOrderCode() {
  const part = String(Date.now()).slice(-6);
  const rnd = Math.floor(10 + Math.random() * 90);
  return `JS-${part}${rnd}`;
}

function simpleRateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const windowMs = 60_000;
  const max = 12;
  const entry = createRate.get(ip) || { start: now, count: 0 };
  if (now - entry.start > windowMs) {
    entry.start = now;
    entry.count = 0;
  }
  entry.count++;
  createRate.set(ip, entry);
  if (entry.count > max) {
    return res.status(429).json({ ok:false, error:"Demasiadas solicitudes. Esperá un minuto." });
  }
  next();
}

async function sixoffFetch(path, options = {}) {
  const headers = {
    "X-API-Key": SIXOFF_API_KEY,
    ...(options.body ? {"Content-Type":"application/json"} : {}),
    ...(options.headers || {})
  };

  const response = await fetch(SIXOFF_BASE_URL + path, { ...options, headers });
  let data = null;
  try { data = await response.json(); }
  catch { data = { message:"Respuesta no JSON" }; }

  return { response, data };
}

async function supabaseFetch(path, options = {}) {
  const headers = {
    // Las nuevas claves sb_secret_ de Supabase se envían como apikey.
    // No se usan como Bearer JWT.
    "apikey": SUPABASE_SECRET_KEY,
    ...(options.body ? {"Content-Type":"application/json"} : {}),
    ...(options.headers || {})
  };

  const response = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch { data = text; }
  }
  return { response, data };
}

async function getDbOrder(code) {
  const q = `/orders?order_code=eq.${encodeURIComponent(code)}&select=*`;
  const { response, data } = await supabaseFetch(q);
  if (!response.ok) throw new Error(`Supabase ${response.status}`);
  return Array.isArray(data) ? (data[0] || null) : null;
}

async function patchDbOrder(code, patch, extraFilter = "") {
  const path = `/orders?order_code=eq.${encodeURIComponent(code)}${extraFilter}`;
  return supabaseFetch(path, {
    method:"PATCH",
    headers:{ "Prefer":"return=representation" },
    body:JSON.stringify({ ...patch, updated_at:new Date().toISOString() })
  });
}

app.get("/", (req,res)=>{
  res.json({
    ok:true,
    service:"Recargas JS API",
    status:"online",
    sixoffConfigured:Boolean(SIXOFF_API_KEY),
    supabaseConfigured:Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY)
  });
});

app.get("/health", (req,res)=>res.json({
  ok:true,
  sixoffConfigured:Boolean(SIXOFF_API_KEY),
  supabaseConfigured:Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY)
}));

// -------------------- PEDIDOS EN SUPABASE --------------------

// Crea una solicitud de cliente. NO recarga diamantes.
app.post("/api/db/orders", requireSupabase, simpleRateLimit, async (req,res)=>{
  const { uid, whatsapp, packageName, priceArs, orderCode } = req.body || {};

  if(!/^\d{8,12}$/.test(String(uid || ""))){
    return res.status(400).json({ok:false,error:"UID inválido."});
  }
  if(!/^[0-9+()\s-]{7,25}$/.test(String(whatsapp || ""))){
    return res.status(400).json({ok:false,error:"WhatsApp inválido."});
  }

  const pkg = String(packageName || "").trim();
  if(!pkg || pkg.length > 80){
    return res.status(400).json({ok:false,error:"Paquete inválido."});
  }

  const price = normalizePrice(priceArs);
  if(!Number.isFinite(price) || price < 0 || price > 10000000){
    return res.status(400).json({ok:false,error:"Precio inválido."});
  }

  const code = /^JS-\d{6,10}$/.test(String(orderCode || "")) ? String(orderCode) : makeOrderCode();

  try{
    const { response, data } = await supabaseFetch("/orders", {
      method:"POST",
      headers:{ "Prefer":"return=representation" },
      body:JSON.stringify({
        order_code:code,
        uid:String(uid),
        whatsapp:String(whatsapp),
        package_name:pkg,
        price_ars:price,
        status:"waiting_payment",
        archived:false
      })
    });

    if(!response.ok){
      if(response.status === 409){
        return res.status(409).json({ok:false,error:"Ese número de pedido ya existe."});
      }
      console.error("Supabase create:", data);
      return res.status(502).json({ok:false,error:"No se pudo guardar el pedido."});
    }

    return res.status(201).json({ok:true, order:Array.isArray(data) ? data[0] : data});
  }catch(err){
    console.error(err);
    return res.status(502).json({ok:false,error:"Error guardando el pedido."});
  }
});

// Lista completa para el admin.
app.get("/api/db/orders", requireAdmin, requireSupabase, async (req,res)=>{
  try{
    const { response, data } = await supabaseFetch("/orders?select=*&order=created_at.desc");
    if(!response.ok){
      console.error("Supabase list:", data);
      return res.status(502).json({ok:false,error:"No se pudieron cargar los pedidos."});
    }
    res.json({ok:true, orders:Array.isArray(data) ? data : []});
  }catch(err){
    console.error(err);
    res.status(502).json({ok:false,error:"Error consultando pedidos."});
  }
});

// Estado público: no expone teléfono ni datos privados.
app.get("/api/db/orders/public/:code", requireSupabase, async (req,res)=>{
  try{
    const code = String(req.params.code || "").trim();
    const path = `/orders?order_code=eq.${encodeURIComponent(code)}&select=order_code,package_name,status,sixoff_status,created_at,delivered_at`;
    const { response, data } = await supabaseFetch(path);
    if(!response.ok) return res.status(502).json({ok:false,error:"No se pudo consultar el pedido."});
    const order = Array.isArray(data) ? data[0] : null;
    if(!order) return res.status(404).json({ok:false,error:"Pedido no encontrado."});
    res.json({ok:true, order});
  }catch(err){
    res.status(502).json({ok:false,error:"Error consultando el pedido."});
  }
});

app.patch("/api/db/orders/:code", requireAdmin, requireSupabase, async (req,res)=>{
  const allowed = new Set(["waiting_payment","paid","processing","done","cancelled","failed"]);
  const patch = {};

  if(req.body && Object.prototype.hasOwnProperty.call(req.body, "status")){
    const status = String(req.body.status || "");
    if(!allowed.has(status)){
      return res.status(400).json({ok:false,error:"Estado inválido."});
    }
    patch.status = status;
    if(status === "done") patch.delivered_at = new Date().toISOString();
  }

  if(req.body && Object.prototype.hasOwnProperty.call(req.body, "archived")){
    patch.archived = Boolean(req.body.archived);
  }

  if(Object.keys(patch).length === 0){
    return res.status(400).json({ok:false,error:"No hay cambios válidos."});
  }

  try{
    const { response, data } = await patchDbOrder(req.params.code, patch);
    if(!response.ok) return res.status(502).json({ok:false,error:"No se pudo actualizar el pedido."});
    const order = Array.isArray(data) ? data[0] : null;
    if(!order) return res.status(404).json({ok:false,error:"Pedido no encontrado."});
    res.json({ok:true, order});
  }catch(err){
    res.status(502).json({ok:false,error:"Error actualizando el pedido."});
  }
});

app.delete("/api/db/orders/:code", requireAdmin, requireSupabase, async (req,res)=>{
  try{
    const existing = await getDbOrder(req.params.code);
    if(!existing) return res.status(404).json({ok:false,error:"Pedido no encontrado."});

    const { response, data } = await supabaseFetch(
      `/orders?order_code=eq.${encodeURIComponent(req.params.code)}`,
      { method:"DELETE", headers:{ "Prefer":"return=representation" } }
    );
    if(!response.ok) return res.status(502).json({ok:false,error:"No se pudo eliminar el pedido."});
    res.json({
      ok:true,
      warning: existing.sixoff_order_id ? "La solicitud se borró del panel, pero una orden ya enviada a SixoFire no se cancela." : null,
      deleted:Array.isArray(data) ? data[0] : data
    });
  }catch(err){
    res.status(502).json({ok:false,error:"Error eliminando el pedido."});
  }
});

// -------------------- SIXOFIRE --------------------

app.get("/api/catalog", requireAdmin, requireSixo, async (req,res)=>{
  try{
    const { response, data } = await sixoffFetch("/account/shop/items");
    if(!response.ok || !data?.status){
      return res.status(response.status || 502).json({
        ok:false,
        error:data?.message || "No se pudo obtener el catálogo de SixoFire.",
        sixoff:data
      });
    }

    const items = Array.isArray(data?.data?.items) ? data.data.items : [];
    const safe = items.map(i => ({
      id:String(i.id),
      name:i.name,
      description:i.description,
      available:Boolean(i.available),
      isActive:Boolean(i.isActive),
      priceUsd:i.priceUsd,
      effectivePriceUsd:i.effectivePriceUsd,
      itemType:i.itemType,
      diamondQuantity:i.diamondQuantity,
      diamondBonus:i.diamondBonus,
      giftDiamonds:i.giftDiamonds
    }));
    res.json({ok:true, items:safe});
  }catch(err){
    res.status(502).json({ok:false,error:"Error conectando con SixoFire."});
  }
});

app.get("/api/catalog/match/:diamonds", requireAdmin, requireSixo, async (req,res)=>{
  const wanted = Number(req.params.diamonds);
  if(!Number.isInteger(wanted) || wanted <= 0){
    return res.status(400).json({ok:false,error:"Cantidad inválida."});
  }

  try{
    const { response, data } = await sixoffFetch("/account/shop/items");
    if(!response.ok || !data?.status){
      return res.status(response.status || 502).json({
        ok:false,
        error:data?.message || "No se pudo obtener el catálogo.",
        sixoff:data
      });
    }

    const items = Array.isArray(data?.data?.items) ? data.data.items : [];
    const matches = items.filter(i => {
      const base = Number(i.diamondQuantity);
      const bonus = Number(i.diamondBonus);
      const gift = Number(i.giftDiamonds);
      const totals = [];
      if (Number.isFinite(base)) totals.push(base);
      if (Number.isFinite(gift)) totals.push(gift);
      if (Number.isFinite(base) && Number.isFinite(bonus)) totals.push(base + bonus);
      return Boolean(i.available) &&
             Boolean(i.isActive) &&
             String(i.itemType || "").toUpperCase().includes("DIAMOND") &&
             totals.includes(wanted);
    }).map(i => ({
      id:String(i.id),
      name:i.name,
      itemType:i.itemType,
      diamondQuantity:i.diamondQuantity,
      diamondBonus:i.diamondBonus,
      giftDiamonds:i.giftDiamonds,
      totalDiamonds:
        (Number.isFinite(Number(i.diamondQuantity)) && Number.isFinite(Number(i.diamondBonus)))
          ? Number(i.diamondQuantity) + Number(i.diamondBonus)
          : (Number.isFinite(Number(i.giftDiamonds)) ? Number(i.giftDiamonds) : Number(i.diamondQuantity)),
      effectivePriceUsd:i.effectivePriceUsd
    }));

    res.json({ok:true, diamonds:wanted, count:matches.length, matches});
  }catch(err){
    res.status(502).json({ok:false,error:"Error conectando con SixoFire."});
  }
});

// Crea la orden real. Si el pedido ya existe en Supabase, usa un bloqueo persistente.
app.post("/api/orders/create", requireAdmin, requireSixo, async (req,res)=>{
  const { uid, packageCode, orderId } = req.body || {};
  const diamonds = Number(packageCode);

  if(!/^\d{8,12}$/.test(String(uid || ""))){
    return res.status(400).json({ok:false,error:"UID inválido. Debe tener entre 8 y 12 dígitos."});
  }
  if(!Number.isInteger(diamonds) || diamonds <= 0){
    return res.status(400).json({ok:false,error:"Paquete inválido."});
  }
  if(!orderId){
    return res.status(400).json({ok:false,error:"Falta orderId."});
  }

  // Bloqueo en memoria como segunda capa.
  if(sentOrders.has(orderId)){
    return res.status(409).json({
      ok:false, duplicate:true,
      error:"Este pedido ya fue enviado a SixoFire.",
      previous:sentOrders.get(orderId)
    });
  }
  if(sendingOrders.has(orderId)){
    return res.status(409).json({ok:false,duplicate:true,error:"Este pedido ya se está procesando."});
  }

  sendingOrders.add(orderId);
  let dbClaimed = false;

  try{
    // Si existe en Supabase, reclamarlo de forma atómica.
    if(SUPABASE_URL && SUPABASE_SECRET_KEY){
      const current = await getDbOrder(orderId);
      if(current){
        if(current.sixoff_order_id || ["processing","done"].includes(current.status)){
          return res.status(409).json({
            ok:false,
            duplicate:true,
            error:"Este pedido ya fue enviado o está procesándose.",
            previous:{
              sixoffOrder:{
                id:current.sixoff_order_id,
                status:current.sixoff_status,
                nickname:current.sixoff_nickname,
                region:current.sixoff_region
              }
            }
          });
        }

        const claim = await patchDbOrder(
          orderId,
          { status:"processing" },
          "&sixoff_order_id=is.null&status=in.(waiting_payment,paid)"
        );

        const claimedRows = Array.isArray(claim.data) ? claim.data : [];
        if(!claim.response.ok || claimedRows.length !== 1){
          return res.status(409).json({ok:false,duplicate:true,error:"El pedido ya fue tomado por otro proceso."});
        }
        dbClaimed = true;
      }
    }

    const catalog = await sixoffFetch("/account/shop/items");
    if(!catalog.response.ok || !catalog.data?.status){
      if(dbClaimed) await patchDbOrder(orderId, { status:"paid" });
      return res.status(catalog.response.status || 502).json({
        ok:false,
        error:catalog.data?.message || "No se pudo consultar el catálogo."
      });
    }

    const items = Array.isArray(catalog.data?.data?.items) ? catalog.data.data.items : [];
    const matches = items.filter(i => {
      const base = Number(i.diamondQuantity);
      const bonus = Number(i.diamondBonus);
      const gift = Number(i.giftDiamonds);
      const totals = [];
      if (Number.isFinite(base)) totals.push(base);
      if (Number.isFinite(gift)) totals.push(gift);
      if (Number.isFinite(base) && Number.isFinite(bonus)) totals.push(base + bonus);
      return Boolean(i.available) &&
             Boolean(i.isActive) &&
             String(i.itemType || "").toUpperCase().includes("DIAMOND") &&
             totals.includes(diamonds);
    });

    if(matches.length !== 1){
      if(dbClaimed) await patchDbOrder(orderId, { status:"paid" });
      return res.status(409).json({
        ok:false,
        error: matches.length === 0
          ? `No encontramos un producto activo equivalente a ${diamonds} diamantes.`
          : `Encontramos ${matches.length} productos compatibles; se requiere selección manual.`,
        candidates:matches.map(i=>({id:String(i.id),name:i.name,itemType:i.itemType}))
      });
    }

    const product = matches[0];
    const order = await sixoffFetch("/account/shop/order", {
      method:"POST",
      body:JSON.stringify({
        uid:String(uid),
        product_id:String(product.id),
        amount:1
      })
    });

    if(!order.response.ok || !order.data?.status){
      if(dbClaimed) await patchDbOrder(orderId, { status:"paid" });
      return res.status(order.response.status || 502).json({
        ok:false,
        error:order.data?.message || "SixoFire rechazó la orden.",
        sixoff:order.data
      });
    }

    const result = {
      orderId,
      product:{
        id:String(product.id),
        name:product.name,
        diamonds,
        priceUsd:product.effectivePriceUsd
      },
      sixoffOrder:{
        id:order.data?.data?.id,
        status:order.data?.data?.status,
        nickname:order.data?.data?.gameAccount?.nickname,
        region:order.data?.data?.gameAccount?.region,
        totalPriceUsd:order.data?.data?.totalPriceUsd,
        newBalance:order.data?.data?.walletTransaction?.newBalance
      }
    };

    sentOrders.set(orderId, result);

    if(SUPABASE_URL && SUPABASE_SECRET_KEY){
      const existing = await getDbOrder(orderId);
      if(existing){
        await patchDbOrder(orderId, {
          status:"processing",
          sixoff_order_id:result.sixoffOrder.id || null,
          sixoff_status:result.sixoffOrder.status || "PENDING",
          sixoff_nickname:result.sixoffOrder.nickname || null,
          sixoff_region:result.sixoffOrder.region || null
        });
      }
    }

    return res.status(201).json({ok:true,...result});
  }catch(err){
    console.error(err);
    return res.status(502).json({ok:false,error:"Error interno al conectar con SixoFire."});
  }finally{
    sendingOrders.delete(orderId);
  }
});

// Consulta estado real por ID SixoFire.
app.get("/api/orders/status/:id", requireAdmin, requireSixo, async (req,res)=>{
  const id = String(req.params.id || "").trim();
  if(!/^\d+$/.test(id)){
    return res.status(400).json({ok:false,error:"ID de orden inválido."});
  }

  try{
    const { response, data } = await sixoffFetch(`/account/shop/orders/${id}`);
    if(!response.ok || !data?.status){
      return res.status(response.status || 502).json({
        ok:false,
        error:data?.message || "No se pudo consultar el estado de la orden.",
        sixoff:data
      });
    }

    const order = data?.data || {};
    return res.json({
      ok:true,
      order:{
        id:order.id,
        status:order.status,
        nickname:order?.gameAccount?.nickname || null,
        uid:order?.gameAccount?.uid || null,
        region:order?.gameAccount?.region || null,
        updatedAt:order.updatedAt || null,
        items:Array.isArray(order.items) ? order.items.map(i=>({
          id:i.id,name:i.name,itemType:i.itemType,status:i.status,quantity:i.quantity
        })) : []
      }
    });
  }catch(err){
    res.status(502).json({ok:false,error:"Error conectando con SixoFire."});
  }
});

// Sincroniza un pedido de nuestra BD con SixoFire y guarda el resultado.
app.post("/api/db/orders/:code/sync", requireAdmin, requireSupabase, requireSixo, async (req,res)=>{
  try{
    const dbOrder = await getDbOrder(req.params.code);
    if(!dbOrder) return res.status(404).json({ok:false,error:"Pedido no encontrado."});
    if(!dbOrder.sixoff_order_id){
      return res.status(400).json({ok:false,error:"Este pedido todavía no tiene orden SixoFire."});
    }

    const { response, data } = await sixoffFetch(`/account/shop/orders/${dbOrder.sixoff_order_id}`);
    if(!response.ok || !data?.status){
      return res.status(response.status || 502).json({ok:false,error:data?.message || "No se pudo consultar SixoFire."});
    }

    const s = data?.data || {};
    const sixStatus = String(s.status || "").toUpperCase();
    const patch = {
      sixoff_status:sixStatus,
      sixoff_nickname:s?.gameAccount?.nickname || dbOrder.sixoff_nickname,
      sixoff_region:s?.gameAccount?.region || dbOrder.sixoff_region
    };

    if(sixStatus === "COMPLETED"){
      patch.status = "done";
      patch.delivered_at = new Date().toISOString();
    } else if(["FAILED","REFUNDED"].includes(sixStatus)){
      patch.status = "failed";
    } else {
      patch.status = "processing";
    }

    const updated = await patchDbOrder(req.params.code, patch);
    const row = Array.isArray(updated.data) ? updated.data[0] : null;
    res.json({ok:true, order:row, sixoffStatus:sixStatus});
  }catch(err){
    console.error(err);
    res.status(502).json({ok:false,error:"Error sincronizando el pedido."});
  }
});

app.listen(PORT, "0.0.0.0", ()=>{
  console.log(`Recargas JS API v7 + Supabase funcionando en puerto ${PORT}`);
});
