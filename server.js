const express = require("express");
const cors = require("cors");

const app = express();

app.use(express.json({ limit: "100kb" }));

// Por ahora permitimos llamadas desde cualquier origen para facilitar las pruebas.
// Cuando la tienda esté publicada, conviene reemplazar "*" por el dominio real.
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"]
}));

const PORT = process.env.PORT || 3000;

// Clave privada para proteger acciones del panel.
// En Render se cargará como ADMIN_SECRET.
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

// Más adelante se usarán estas variables para SixoFire.
// NO pongas claves dentro de este archivo ni en GitHub.
const SIXOFF_API_KEY = process.env.SIXOFF_API_KEY || "";
const SIXOFF_BASE_URL = process.env.SIXOFF_BASE_URL || "";

function requireAdmin(req, res, next) {
  const secret = req.get("x-admin-secret");

  if (!ADMIN_SECRET) {
    return res.status(503).json({
      ok: false,
      error: "ADMIN_SECRET todavía no está configurado en Render."
    });
  }

  if (secret !== ADMIN_SECRET) {
    return res.status(401).json({
      ok: false,
      error: "No autorizado."
    });
  }

  next();
}

// Comprobación rápida para saber si el servidor está encendido.
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Recargas JS API",
    status: "online",
    sixoffConfigured: Boolean(SIXOFF_API_KEY && SIXOFF_BASE_URL)
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Endpoint que usaremos desde el panel al confirmar un pago.
// Por ahora NO envía ninguna recarga real.
// Quedará listo para conectar cuando tengamos la documentación de SixoFire.
app.post("/api/orders/create", requireAdmin, async (req, res) => {
  const { uid, packageCode, orderId } = req.body || {};

  if (!uid || !packageCode || !orderId) {
    return res.status(400).json({
      ok: false,
      error: "Faltan uid, packageCode u orderId."
    });
  }

  if (!SIXOFF_API_KEY || !SIXOFF_BASE_URL) {
    return res.status(503).json({
      ok: false,
      error: "SixoFire todavía no está configurado.",
      received: { uid, packageCode, orderId }
    });
  }

  // AQUÍ irá la llamada real a SixoFire.
  // No la implementamos hasta ver su documentación oficial.
  return res.status(501).json({
    ok: false,
    error: "Integración SixoFire pendiente de documentación."
  });
});

// Endpoint preparado para consultar una orden en el futuro.
app.get("/api/orders/:id", requireAdmin, async (req, res) => {
  if (!SIXOFF_API_KEY || !SIXOFF_BASE_URL) {
    return res.status(503).json({
      ok: false,
      error: "SixoFire todavía no está configurado."
    });
  }

  return res.status(501).json({
    ok: false,
    error: "Consulta SixoFire pendiente de documentación."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Recargas JS API funcionando en puerto ${PORT}`);
});
