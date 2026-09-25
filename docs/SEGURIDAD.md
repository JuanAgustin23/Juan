# Seguridad de la carta y la caja

## Cómo está publicada hoy

- **Hosting:** Render, plan gratuito (servicio `rucka-monkey-demo`).
- **Dirección:** `https://rucka-monkey-demo.onrender.com`. Es un subdominio de `onrender.com`, que es de Render, no tuyo.
- **DNS:** lo administra Render. La dirección apunta a la red de Render (216.24.57.x).
- **Cloudflare:** Render ya hace pasar todo el tráfico por Cloudflare para protegerlo de ataques de denegación de servicio (DDoS). Eso está activo sin que hagas nada, pero **no tienes acceso a sus reglas**.
- **Dominio propio:** no hay. Sin un dominio tuyo no puedes agregar este sitio a tu cuenta de Cloudflare, ni poner reglas de firewall, límites de solicitudes o ajustes de HTTPS propios.

## Activo en la aplicación (no depende de Cloudflare)

| Protección | Detalle |
|---|---|
| Panel y API protegidos en el servidor | Las 26 funciones internas responden 401 sin sesión o con una cookie falsa. Hay una prueba automática que las recorre todas. |
| Inicio de sesión | Contraseña guardada con scrypt. Máximo 8 intentos fallidos por IP cada 15 minutos. Si llegan muchos fallos desde muchas IP, cada intento se frena sin bloquear al cajero. |
| Sesión | Cookie `HttpOnly`, `Secure` y `SameSite=Strict`, válida 12 horas. Se registra en el servidor, así que "Cerrar sesión" o cambiar la contraseña la invalidan de verdad. |
| IP real del cliente | `CLIENT_IP_HEADER=cf-connecting-ip`. Así los límites se aplican a cada cliente y no a todos los que comparten un servidor intermedio. |
| Pedidos | El servidor recalcula precios, extras y totales, y valida las cantidades (de 1 a 20 por línea, hasta 40 líneas). Los reenvíos por mala señal no duplican el pedido. |
| Límites de pedidos | Se permiten 4 pedidos cada 10 minutos por conexión sin ningún desafío. Desde el 5.º se pide Turnstile, si está configurado. Hay un máximo de 20 (30 con Turnstile). |
| Límite general de la API | 300 solicitudes por minuto por cliente. La caja y la carta usan menos de 20. |
| Comprobantes | Se guardan fuera de la carpeta pública y solo se abren con sesión de caja. Se sirven con `no-store` y `sandbox`. El estado público del pedido no los muestra. |
| Adjuntos | Solo JPG, PNG o WEBP, reconocidos por su contenido y no por el nombre del archivo, de hasta 8 MB. Un archivo rechazado no queda en disco. |
| Cabeceras | HSTS, CSP estricta (solo scripts propios y, con Turnstile, los de Cloudflare), `X-Frame-Options`, `nosniff`, `Permissions-Policy`. |
| Claves | Ninguna clave está en el código. La contraseña de caja la genera Render (`ADMIN_PASSWORD`) y las claves de Turnstile van solo en Render → Environment. |

Para revisar el estado en vivo, entra a Caja → **Ajustes → Seguridad**.

## Turnstile (gratis, funciona sin dominio propio)

Turnstile es el "no soy un robot" de Cloudflare. Casi nunca pide un clic.

1. En https://dash.cloudflare.com → **Turnstile** → **Add widget**.
2. Nombre: `Rucka Monkey`. Hostname: `rucka-monkey-demo.onrender.com`. Modo: **Managed**.
3. Copia la **Site Key** y la **Secret Key**.
4. En Render → servicio → **Environment**, agrega `TURNSTILE_SITE_KEY` y `TURNSTILE_SECRET_KEY` con esos valores. Opcional: `TURNSTILE_HOSTNAMES=rucka-monkey-demo.onrender.com`. Guarda, y Render reinicia el servicio.
5. Comprueba: en `/caja` aparece la verificación sobre el botón **Entrar**, y en **Ajustes → Seguridad** Turnstile figura como **Activo**.

Solo se usa en el inicio de sesión de caja y a partir del 5.º pedido seguido desde una misma conexión. Quien escanea el QR y pide una vez no ve nada. Si falta alguna de las dos claves, Turnstile queda apagado y la app funciona igual que antes.

## Lo que requiere un dominio propio (por ejemplo `ruckamonkey.cl`)

Con un dominio tuyo agregado a Cloudflare (plan gratuito) puedes activar lo siguiente:

1. **DNS:** crea un registro `CNAME` de `carta` (o de `www`) a `rucka-monkey-demo.onrender.com`, al principio en modo **DNS only** (nube gris). En Render → **Settings → Custom Domains**, agrega `carta.tudominio.cl` y espera a que el certificado figure como válido. Recién entonces cambia el registro a **Proxied** (nube naranja).
2. **SSL/TLS:** modo **Full (strict)**, **Always Use HTTPS**, **Minimum TLS 1.2** y HSTS.
3. **Límite de solicitudes** (el plan gratuito permite 1 regla): la expresión `(http.request.uri.path eq "/api/admin/login") or (http.request.uri.path eq "/api/orders" and http.request.method eq "POST")`, con un máximo de **10 solicitudes cada 10 segundos por IP** y acción **Block**. No afecta a quien mira la carta.
4. **Reglas de seguridad** (opcional): un **Managed Challenge** solo para `/caja` fuera de Chile (`http.request.uri.path eq "/caja" and ip.src.country ne "CL"`). No actives "Under Attack Mode" ni desafíos para toda la carta.
5. **Candado de origen**, para que nadie se salte Cloudflare entrando por `onrender.com`:
   - En Cloudflare → **Rules → Transform Rules → Modify Request Header**, agrega `X-Origin-Secret: <valor largo al azar>`.
   - En Render → **Environment**, agrega `ORIGIN_SECRET` con el mismo valor y `PUBLIC_BASE_URL=https://carta.tudominio.cl`.
   - Quien entre directo a `onrender.com` es redirigido o rechazado. Actívalo **después** de comprobar que el dominio funciona.
6. Actualiza el Hostname de Turnstile y genera el QR definitivo con la nueva dirección.
