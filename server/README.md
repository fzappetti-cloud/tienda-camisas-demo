# Servidor de cobro (ambiente de prueba)

Sirve para **medir el trabajo real de los pagos** antes de cerrar el precio. No tiene dependencias y corre solo cuando hay una compra.

## 1. Prueba local con Mercado Pago falso (sin cuentas, sin dinero)
```
node server/test.js
```
Verifica 27 controles: precio calculado por el servidor, "pagado" solo con confirmación, aviso repetido, monto distinto, aviso falso, claves no expuestas, Mercado Pago caído, etc.

## 2. Prueba con Mercado Pago real en modo de prueba (lo hace Franco, con SU cuenta de desarrollador)
1. Entrá a Mercado Pago Developers → creá una aplicación (Checkout Pro).
2. Creá usuarios de prueba (vendedor y comprador).
3. Copiá el **Access Token de prueba** (empieza con `TEST-`). No lo pegues en el código ni en el chat.
4. Publicá este servidor en Railway (Root Directory: `server`, comando de inicio: `npm start`) y cargá estas **variables** en Railway:

| Variable | Qué es |
|---|---|
| `MP_ACCESS_TOKEN` | Access Token de prueba de Mercado Pago |
| `BASE_URL` | Dirección pública del servidor en Railway (https://...) |
| `FRONT_URL` | Dirección de la tienda (https://fzappetti-cloud.github.io/tienda-camisas-demo/tienda/) |
| `ADMIN_TOKEN` | Clave larga que inventás, para ver pedidos y alertas |
| `WEBHOOK_SECRET` | "Clave secreta" del webhook que muestra Mercado Pago (opcional pero recomendado) |
| `DATA_DIR` | Carpeta de datos. En Railway los archivos se borran al reiniciar: para producción usar un Volume |

5. En Mercado Pago, en Webhooks, cargá `BASE_URL/webhook/mp` y marcá el evento "Pagos".
6. Hacé una compra con una tarjeta de prueba (la lista actual está en la documentación de Mercado Pago).
7. Revisá con `GET BASE_URL/api/orders` y `/api/alerts` (header `x-admin-token`).

## 3. Casos para repetir con Mercado Pago real
- Aprobado, rechazado y pendiente.
- Cambiar el precio en el navegador (debe ignorarse).
- Enviar a mano un aviso falso (debe ignorarse).
- Aviso repetido (se procesa una sola vez).
- Apagar el servidor y comprar (debe avisar el error, sin dejar nada "pagado").

## Límites de este ambiente de prueba
- Guarda pedidos en un archivo, no en base de datos.
- Las alertas se escriben en el registro; falta conectarlas a mail o WhatsApp.
- No incluye el panel de la clienta ni la conexión con la tienda del demo.
- Validación de firma del webhook escrita según la documentación conocida de Mercado Pago: confirmarla contra el entorno real.
