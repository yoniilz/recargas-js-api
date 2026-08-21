# Recargas JS API

Servidor privado para conectar el panel de Recargas JS con SixoFire.

## Render

Configuración recomendada:

- Language: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Instance: Free

## Variables privadas en Render

Por ahora podés crear solamente:

- `ADMIN_SECRET` = una contraseña larga y aleatoria

Más adelante, cuando tengamos la documentación de SixoFire:

- `SIXOFF_API_KEY`
- `SIXOFF_BASE_URL`

**Nunca subas las claves reales a GitHub.**

## Prueba

Cuando Render termine el deploy, abrí la URL que te dé.
Debería mostrar un JSON con:

`"service": "Recargas JS API"` y `"status": "online"`
