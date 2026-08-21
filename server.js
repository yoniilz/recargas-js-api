const express = require("express");
const cors = require("cors");

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(cors({ origin: "*", methods: ["GET", "POST"] }));

const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const SIXOFF_API_KEY = process.env.SIXOFF_API_KEY || "";
const SIXOFF_BASE_URL = "https://api.sixofire.net";

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
    return res.status(503).json({
      ok:false,
      error:"SIXOFF_API_KEY todavía no está configurada en Render."
    });
  }
  next();
}

async function sixoffFetch(path, options = {}) {
  const headers = {
    "X-API-Key": SIXOFF_API_KEY,
    ...(options.body ? {"Content-Type":"application/json"} : {}),
    ...(options.headers || {})
  };

  const response = await fetch(SIXOFF_BASE_URL + path, {
    ...options,
    headers
  });

  let data = null;
  try { data = await response.json(); }
  catch { data = { message:"Respuesta no JSON" }; }

  return { response, data };
}

app.get("/", (req,res)=>{
  res.json({
    ok:true,
    service:"Recargas JS API",
    status:"online",
    sixoffConfigured:Boolean(SIXOFF_API_KEY)
  });
});

app.get("/health", (req,res)=>res.json({ok:true}));

// Catálogo real de SixoFire, protegido.
// Devuelve solo campos útiles para no exponer información innecesaria.
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

// Busca de forma SEGURA el producto por cantidad.
// Solo devuelve coincidencias; NO compra nada.
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

      const type = String(i.itemType || "").toUpperCase();
      const diamondType = type.includes("DIAMOND");

      return Boolean(i.available) &&
             Boolean(i.isActive) &&
             diamondType &&
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

    res.json({
      ok:true,
      diamonds:wanted,
      count:matches.length,
      matches
    });
  }catch(err){
    res.status(502).json({ok:false,error:"Error conectando con SixoFire."});
  }
});

// Crea la orden REAL.
// Seguridad: solo compra si encuentra EXACTAMENTE 1 producto compatible
// para la cantidad solicitada.
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

  try{
    // 1) Consultar catálogo
    const catalog = await sixoffFetch("/account/shop/items");
    if(!catalog.response.ok || !catalog.data?.status){
      return res.status(catalog.response.status || 502).json({
        ok:false,
        error:catalog.data?.message || "No se pudo consultar el catálogo."
      });
    }

    const items = Array.isArray(catalog.data?.data?.items) ? catalog.data.data.items : [];

    // 2) Buscar coincidencia estricta
    const matches = items.filter(i => {
      const base = Number(i.diamondQuantity);
      const bonus = Number(i.diamondBonus);
      const gift = Number(i.giftDiamonds);

      const totals = [];
      if (Number.isFinite(base)) totals.push(base);
      if (Number.isFinite(gift)) totals.push(gift);
      if (Number.isFinite(base) && Number.isFinite(bonus)) totals.push(base + bonus);

      const type = String(i.itemType || "").toUpperCase();
      const diamondType = type.includes("DIAMOND");

      return Boolean(i.available) &&
             Boolean(i.isActive) &&
             diamondType &&
             totals.includes(diamonds);
    });

    if(matches.length !== 1){
      return res.status(409).json({
        ok:false,
        error: matches.length === 0
          ? `No encontramos un producto activo de ${diamonds} diamantes.`
          : `Encontramos ${matches.length} productos compatibles; se requiere selección manual para evitar una compra incorrecta.`,
        candidates: matches.map(i=>({
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
        }))
      });
    }

    const product = matches[0];

    // 3) Crear orden real
    const order = await sixoffFetch("/account/shop/order", {
      method:"POST",
      body:JSON.stringify({
        uid:String(uid),
        product_id:String(product.id),
        amount:1
      })
    });

    if(!order.response.ok || !order.data?.status){
      return res.status(order.response.status || 502).json({
        ok:false,
        error:order.data?.message || "SixoFire rechazó la orden.",
        sixoff:order.data
      });
    }

    res.status(201).json({
      ok:true,
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
    });

  }catch(err){
    console.error(err);
    res.status(502).json({ok:false,error:"Error interno al conectar con SixoFire."});
  }
});

app.listen(PORT, "0.0.0.0", ()=>{
  console.log(`Recargas JS API v2 funcionando en puerto ${PORT}`);
});
