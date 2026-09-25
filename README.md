# Rucka Monkey: carta digital, pedidos y caja

> **Versión de DEMOSTRACIÓN.** Los precios, las bebidas y los datos bancarios son de prueba, y las descripciones son provisionales. Las imágenes son **ilustraciones vectoriales hechas para la demo, no fotos del local**. Todo se puede cambiar desde el panel sin tocar código.

Hay dos partes, y las dos funcionan completas en un celular:

| Parte | Dirección | Para quién |
|---|---|---|
| Carta y pedidos | `/` (a la que lleva el QR) | Clientes |
| Panel de caja y administración | `/admin` (protegido con contraseña) | Cajero o dueño |

## Qué hace

**Cliente (celular primero)**
- Ve categorías, ilustraciones rotuladas como tales, descripciones y precios. Los precios de prueba y las descripciones provisionales llevan su etiqueta.
- Personaliza cada producto: marca los ingredientes que quiere **quitar**, escribe una **nota** (140 caracteres) y elige extras con costo, pero solo los que el local haya configurado.
- Dos unidades del mismo producto pueden llevar indicaciones distintas: se agregan por separado, o desde el carrito con **"Indicación distinta para 1"**, y quedan como líneas separadas.
- En el carrito puede sumar, restar, editar y eliminar, y ve el total.
- Paga en **efectivo** o por **transferencia**. Si elige transferencia, ve los datos bancarios y puede adjuntar una imagen del comprobante. El sistema le avisa que el comprobante **no confirma el pago**.
- Después de enviar ve el número de su pedido y el estado, que se actualiza solo.

**Caja (pensada para un cajero con solo un celular)**
- Los pedidos nuevos aparecen solos (se revisa cada 4 segundos), con aviso por vibración y un sonido opcional. La pantalla se mantiene encendida si el navegador lo permite.
- Cada pedido muestra sus productos, cantidades, los ingredientes quitados en rojo ("SIN tomate"), los extras y las notas destacadas en amarillo.
- Para **confirmar el pago**, el cajero tiene que marcar dos cosas: "leí las indicaciones y el local puede cumplirlas" y "verifiqué el abono en la cuenta bancaria" (o "recibí el efectivo"). El servidor exige esa confirmación. Un pedido no puede pasar a preparación sin pago confirmado.
- Los estados son: pendiente → pago confirmado → en preparación → listo → entregado, más rechazado (con motivo). Un pedido rechazado se puede reabrir.
- Los comprobantes solo se ven con sesión iniciada. Se guardan fuera de la carpeta pública.
- Desde **Productos** se pueden crear, editar, desactivar, ordenar y eliminar productos y categorías. También se cambian precios, descripciones, ingredientes (se pueden quitar o no, provisional o no), extras con precio, y se sube la foto real (se puede tomar con la cámara del celular).
- **Resumen**: pedidos del día, pendientes, ventas confirmadas y ticket promedio, calculados con el día de Chile (America/Santiago, con cambio de horario). Los pedidos reales y los de demostración se muestran **por separado**.
- **Ajustes**: datos bancarios, dirección pública, QR de prueba, QR definitivo, borrar pedidos de demostración y cambiar la contraseña.

**Seguridad y consistencia**
- El servidor **recalcula todos los precios y totales**. Si el total que muestra el celular no coincide, el pedido se rechaza y la carta se actualiza.
- Las notas **nunca se cobran**. Solo se cobran los extras configurados en el panel.
- **No hay pedidos duplicados**: cada envío lleva un identificador único, y si se reintenta por mala señal, el servidor devuelve el mismo pedido.
- El panel está protegido en el servidor: la contraseña se guarda como hash scrypt, la sesión va en una cookie HttpOnly con SameSite=Strict, las modificaciones exigen una cabecera anti-CSRF y hay un límite de intentos de inicio de sesión.
- Las imágenes subidas se validan por su contenido (JPG, PNG o WEBP) y no pueden pesar más de 8 MB.
- Mientras la demo esté activa, los pedidos se llaman **DEMO-0001**, **DEMO-0002**, etc. Clientes y caja ven el aviso "MODO DEMOSTRACIÓN" y esos pedidos no cuentan como ventas reales.
- **No se puede salir del modo demostración** mientras queden precios de prueba, bebidas de ejemplo, descripciones o ingredientes provisionales, datos bancarios de prueba o falte la dirección pública. El QR definitivo solo se genera fuera del modo demostración.

## Ejecutar

Se necesita Node.js 22.13 o superior. La base de datos es SQLite, incluida en Node, y no hay que instalar nada más.

```bash
npm install
ADMIN_PASSWORD='una-clave-larga' npm start
# Carta:  http://localhost:3000
# Caja:   http://localhost:3000/admin
```

Si no defines `ADMIN_PASSWORD`, la primera vez se genera una contraseña y se muestra en la consola. Se puede cambiar desde **Ajustes**.

| Variable | Uso |
|---|---|
| `PORT` | Puerto (por defecto 3000) |
| `ADMIN_PASSWORD` | Contraseña del panel |
| `DATA_DIR` | Carpeta de la base de datos, los comprobantes y las fotos (por defecto `./data`). **Tiene que estar en un disco persistente y con respaldo.** |
| `TRUST_PROXY` | Ponla en `1` si el servidor está detrás de un proxy o de un hosting con HTTPS, para que la cookie de sesión sea `Secure` |

### Probar con dos teléfonos
1. Levanta el servidor en un computador conectado a la misma red Wi-Fi que los teléfonos, o en un hosting de prueba.
2. En el **teléfono del cajero**, abre `http://<IP-del-computador>:3000/admin`, inicia sesión y ve a **Ajustes → Mostrar QR de prueba**. En "Dirección de la demo" pon la dirección a la que llegan los teléfonos.
3. Escanea ese QR con el **teléfono del cliente**, arma un pedido y envíalo. Aparecerá solo en el teléfono del cajero.

También puedes generar el QR como archivo: `npm run qr -- http://192.168.1.50:3000` crea `docs/qr/QR-PRUEBA-NO-PUBLICAR.png`.

### Publicar la versión real
Tiene que ser un hosting con Node.js, HTTPS y **disco persistente** para `DATA_DIR`, por ejemplo un VPS, Railway con volumen o Fly.io con volumen. Cuando el panel ya haya salido del modo demostración, genera el QR definitivo desde **Ajustes → QR definitivo**, o con `npm run qr -- https://tu-direccion --final`.

## Pruebas

```bash
npm test                              # 12 pruebas de la API: pedido completo, duplicados, precios, seguridad, zona horaria
node test/e2e-dos-telefonos.js        # navegador real: teléfono del cliente + teléfono del cajero + computador
```

La prueba de navegador simula un iPhone (390 px) como cliente y un Android pequeño (360 px) como cajero. Sigue estos pasos:
1. El cajero genera el QR de prueba y la prueba lo **decodifica**.
2. El cliente escanea el QR y pide **dos "ASS normal" con indicaciones distintas**: sin tomate y "bien tostado", y sin mayonesa y "agregar mostaza". Además suma y resta unidades en el carrito, paga por transferencia y adjunta el comprobante.
3. El pedido aparece solo en el teléfono del cajero. El cajero abre el comprobante, confirma el pago con las verificaciones y avanza los estados, y el teléfono del cliente se actualiza solo.
4. El cajero cambia un precio desde su celular y el cambio se ve en la carta del cliente.
5. Se revisa la vista de computador.

En cada pantalla se verifica que no haya desplazamiento horizontal y que los botones tengan tamaño táctil suficiente. Las capturas quedan en `docs/capturas/`.

## Estructura

```
server/        index.js (rutas), orders.js (pedidos y estados), auth.js, db.js, seed.js (datos de la demo), time.js (hora de Chile)
public/        index.html + js/menu.js (carta), admin.html + js/admin.js (caja), css/, img/illus/ (ilustraciones)
scripts/       make-illustrations.py (regenera las ilustraciones), make-qr.js
test/          api.test.js, e2e-dos-telefonos.js
```

## Datos que hay que confirmar antes de operar de verdad

El panel muestra esta lista en vivo en **Ajustes → Modo de operación**.

1. **Precio real** de cada producto. Hoy los 16 productos y las 4 bebidas tienen precio de prueba.
2. **Bebidas reales**: nombre, formato (lata, 1,5 L, etc.) y precio. Hay que eliminar o desactivar las 4 de ejemplo.
3. **Ingredientes y descripción** de cada producto, en especial el ASS, el completo dinámico, la chorrillana, las fajitas, el Churrasco Rucka Monkey y las quesadillas. Hay que confirmar también qué ingredientes se pueden quitar.
4. **Tamaños**: qué diferencia hay entre normal y grande, y entre chica, mediana y grande. También cuántas empanaditas trae una porción.
5. **Extras con costo**, si el local los ofrece: nombre y precio. Hoy no hay ninguno configurado.
6. **Datos bancarios reales**: titular, RUT, banco, tipo y número de cuenta, y correo.
7. **Dirección web definitiva** (https) y el hosting donde quedará.
8. **Fotos reales** de los productos. Es opcional: mientras no estén, se muestran las ilustraciones con su rótulo.
9. Una **contraseña definitiva** para la caja, y quién va a tenerla.
