# Stocky: correcciones y pruebas de varios rubros

Última batería completa: 20 de octubre de 2026, 6:14 p. m. a 20 de octubre de 2026, 6:22 p. m. (America/Montevideo).

## Cambios

- Distinguir ingresos como «sumá/cargá productos» de ventas y cargos a cuenta.
- Conservar unidades comerciales explícitas: par, caja, paquete, botella, kg y metro; preguntar por equivalencias de envases desconocidas.
- Presentar las variantes del catálogo agrupadas, respetar el talle o medida de cada producto y consultar todos los datos compartidos que faltan en una sola pregunta.
- Interpretar «dejale el precio en cero» como cambio de precio, conservando cero como valor válido.
- Reconocer la moneda declarada en lenguaje común: pesos argentinos = ARS, pesos uruguayos = UYU.
- Admitir productos de otros rubros sin exigir talle ni precio opcional, y ventas sin un cliente obligatorio.
- Usar razonamiento medio en el intérprete universal, manteniendo el mismo modelo y los valores por defecto del resto del cliente de IA. El ajuste por petición usa el parámetro documentado por [Gemini](https://ai.google.dev/gemini-api/docs/openai#thinking).
- Permitir una sola reparación de evidencia o formato: se vuelve a validar todo y se rechaza cualquier cambio en acciones, referencias, cantidades, atributos, unidades o precios. Solo se admite completar un motivo requerido ausente y corregir las citas literales. Los fallos de proveedor y las referencias o permisos inválidos no generan esa reparación.

## Resultado con el modelo real

- Modelo: **gemini/gemini-3.5-flash-lite**, razonamiento solicitado **medium**.
- Primera pasada ampliada, antes de los últimos ajustes: **29/38** correctos. Se conservaron sus 9 fallos en el JSON de esa ejecución.
- Última pasada completa: **38/38** correctos, 0 fallos; **44 llamadas** reales.
- Reparaciones de formato en la última pasada: 0; exitosas: 0. Cada reparación está incluida en el número de llamadas.
- Un intento previo se detuvo tras 1 llamada por indisponibilidad del proveedor, antes de completar la batería. Se limpiaron sus tablas temporales. Una prueba posterior respondió correctamente y permitió iniciar la pasada completa indicada arriba.
- Repetición focalizada adicional: **7/7** correctos, 9 llamadas; no sustituye una pasada completa.
- Estado del último intento disponible por escenario: **38/38** correctos.
- Una petición activa a la vez, pausas de al menos 6 segundos tras cada respuesta, sin reintentos de transporte ni cambio automático de proveedor en el evaluador.

## Cobertura

Ropa: remeras, shorts, buzos, camperas, polleras, tops, medias por par, pantalones, musculosas y calzas. Ferretería: cable por metro, tornillos por kilo y medida, tarugos por caja y merma de rollos de cinta. Kiosco y almacén: bebidas por botella, yerba y fideos por paquete, alfajores y caramelos por caja.

Operaciones: altas, ingresos, ventas, reservas, bajas por daño, cambios de precio, fiado, pagos, pedidos, consultas, respuestas breves, correcciones, cancelación, falta de stock y rollback de una operación que había cargado primero una cuenta.

## Base de producción y persistencia

Se copiaron 31 productos activos de un catálogo real y se agregaron 19 productos sintéticos, clientes y proveedor de prueba. Se usó la conexión de sesión de la base de producción con tablas temporales. Los ejecutores no tuvieron acceso a public por search_path al escribir. No se enviaron mensajes de WhatsApp ni se modificaron filas permanentes.

En la última pasada, 30 escenarios compararon stock y saldos SQL contra los cambios pedidos, 30 verificaron que repetir la confirmación no duplicara efectos y 3 comprobaron rechazos esperados por falta de stock. Limpieza temporal: **verificada**; repetición: **verificada**.

Las tablas temporales copiaron columnas, valores por defecto, restricciones CHECK e índices. LIKE no copia claves foráneas, RLS ni triggers; esas capas no quedan validadas por esta batería. Las pruebas se ejecutaron con el código local y el proveedor real; no prueban el despliegue de Render, la interfaz web, la transcripción de audio ni el envío real de WhatsApp.

## Regresiones automáticas

- Suite de inventario: 165 pruebas correctas.
- Comprobador independiente del evaluador: 5 pruebas correctas, incluyendo unidades, precios opcionales y cambios SQL incorrectos.
- PostgreSQL temporal local: 339 comprobaciones de integración correctas, incluyendo borradores, concurrencia, atomicidad, recuperación y mensajes.

## Escenarios de la última pasada completa

### Correcto · 01-remeras-coloquial · Ingreso

> Che, entraron tres remeras oversize negras talle L. Sumalas nomás.

### Correcto · 02-short-y-buzo · Ingreso

> Me llegaron 2 shorts running azules M y 1 buzo frisa gris XL, metelos al stock.

### Correcto · 03-polleras-y-tops-nuevos · Productos nuevos

> Cargame como productos nuevos dos polleras plisadas beige talle 2 y tres tops acanalados chocolate talle único. Las polleras van a 32 lucas pesos argentinos y los tops a 18 lucas pesos argentinos.

### Correcto · 04-campera-jean · Productos nuevos

> Agregá al inventario una campera de jean nueva, azul, talle S, a 58.500 pesos argentinos.

### Correcto · 05-medias-por-par · Productos nuevos

> Entraron 4 pares de medias lisas negras talle único, nuevas, y cada par sale 4 lucas pesos argentinos. Cargalas al stock.

### Correcto · 06-venta-lucas · Venta

> Se fueron dos remeras oversize negras L, cobré 25 lucas pesos argentinos cada una. Registrá la venta.

### Correcto · 07-reserva-sin-venta · Reserva

> Guardame un short running azul talle M para mañana. Reservalo nomás, todavía no lo vendí.

### Correcto · 08-fiado-mica · Cuenta corriente

> A Mica Rojas anotale 35 lucas en la cuenta por las prendas que se llevó fiadas.

### Correcto · 09-pago-bauti · Cuenta corriente

> Bauti Pérez me pasó 12 lucas, descontáselas de lo que debe.

### Correcto · 10-venta-y-fiado · Operación mixta

> Se vendió una campera rompeviento negra M y a Mica Rojas sumale 48 lucas que quedó debiendo.

### Correcto · 11-pedido-cargo · Pedido

> Anotale a Bauti Pérez un pedido de dos pantalones cargo verdes talle 44 con Textil Sur; dejalo pendiente.

### Correcto · 12-corregir-pedido · Pedido

> El pedido pendiente de Mica Rojas por la calza ciclista negra M dejalo en tres, que me pidió dos más.

### Correcto · 13-consulta-variantes · Consulta

> ¿Cuántas remeras oversize negras talle L me quedan? Decime también las M.

### Correcto · 14-venta-ambigua-y-respuesta · Aclaración

> Vendí una remera oversize negra.

Respuesta/corrección: «La L».

### Correcto · 15-talle-para-grupo · Aclaración grupal

> Entraron dos shorts running azules y dos remeras oversize negras. Sumalos al stock.

Respuesta/corrección: «talle L».

### Correcto · 16-conservar-talle-previo · Aclaración parcial

> Sumá una remera oversize negra M y un short running azul.

Respuesta/corrección: «La L».

### Correcto · 17-rectificar-cantidad · Corrección

> Vendí dos buzos frisa grises XL.

Respuesta/corrección: «Pará, fue uno solo. Me confundí.».

### Correcto · 18-no-pedir-precio-opcional · Ingreso

> Me llegaron dos musculosas deportivas blancas S y no sé a cuánto venderlas todavía. Sumalas.

### Correcto · 19-precio-cero · Precio

> La calza ciclista negra M va gratis en la promo, dejale el precio en cero pesos argentinos.

### Correcto · 20-stock-insuficiente · Validación

> Vendí 99 camisetas Barrio Norte titular 2026 talle L.

Rechazo esperado: INSUFFICIENT_STOCK; rollback verificado: sí.

### Correcto · 21-mixta-sin-stock-atomica · Atomicidad

> Vendí 99 camisetas Barrio Norte titular 2026 talle L y a Mica Rojas sumale 5 lucas a su cuenta por esa compra fiada.

Rechazo esperado: INSUFFICIENT_STOCK; rollback verificado: sí.

### Correcto · 22-alta-clienta · Cliente

> Dame de alta a Cami Fernández como clienta, dejá anotado que retira por el local.

### Correcto · 23-cancelar-carga · Cancelación

> Che, entraron tres remeras oversize negras talle L.

### Correcto · 24-consulta-catalogo-produccion · Catálogo real

> Decime cuánto stock disponible y reservado tengo del producto "Camiseta Argentina suplente 2026 versión jugador", talle M.

### Correcto · 25-ferreteria-cable-metros · Ferretería · ingreso

> Che, llegaron siete metros de cable unipolar de 2,5 mm². Sumalos al stock.

### Correcto · 26-ferreteria-tornillos-kilos · Ferretería · venta

> Vendí dos kilos de tornillos zincados de 6 mm, sin anotar precio por ahora.

### Correcto · 27-ferreteria-cajas-nuevas · Ferretería · alta

> Cargá como producto nuevo 4 cajas de tarugos de nylon de 8 mm. Cada caja va a 12 lucas pesos argentinos.

### Correcto · 28-ferreteria-aclarar-medida · Ferretería · aclaración

> Sumá dos kilos de tornillos zincados.

Respuesta/corrección: «Los de 8 mm».

### Correcto · 29-ferreteria-merma · Ferretería · merma

> Sacá del stock dos rollos de cinta de embalar transparente de 48 mm porque se arruinaron con el agua. No fue una venta.

### Correcto · 30-kiosco-yerba-paquetes · Kiosco · ingreso

> Me dejaron cinco paquetes de yerba suave de medio kilo. Cargalos al stock.

### Correcto · 31-kiosco-venta-botellas · Kiosco · venta

> Se vendieron tres botellas de agua mineral sin gas de un litro y medio, a 1.500 pesos argentinos cada una.

### Correcto · 32-kiosco-caramelos-nuevos · Kiosco · alta

> Dame de alta dos cajas de caramelos frutales, producto nuevo. Las vendo a 3 lucas pesos argentinos la caja.

### Correcto · 33-kiosco-rollback-cargo-previo · Kiosco · atomicidad

> A Mica Rojas sumale 5 lucas a su cuenta y registrá la venta de 99 botellas de gaseosa cola de 2,25 litros.

Rechazo esperado: INSUFFICIENT_STOCK; rollback verificado: sí.

### Correcto · 34-kiosco-ingreso-mixto · Kiosco · varias unidades

> Ingresá dos paquetes de yerba suave de 500 gramos y seis alfajores triples de chocolate.

### Correcto · 35-kiosco-consulta-bebidas · Kiosco · consulta

> ¿Cuántas botellas me quedan de agua mineral sin gas de 1,5 litros y de gaseosa cola de 2,25 litros?

### Correcto · 36-kiosco-no-inventar-conversion · Kiosco · unidad ambigua

> Vendí una caja de agua mineral sin gas de 1,5 litros. Registrala.

### Correcto · 37-almacen-alta-sin-precio · Almacén · alta sin precio

> Dame de alta 3 paquetes nuevos de fideos tirabuzón marca Molino Chico, todavía no tengo el precio de venta.

### Correcto · 38-ferreteria-corregir-cantidad · Ferretería · corrección

> Vendí diez metros de cable unipolar de 2,5 mm².

Respuesta/corrección: «Pará, fueron ocho metros, corregilo.».

## Repetir

```powershell
npm run test:argentine-evaluation
npm run eval:argentine:live -- --out scripts/test-results-cross-sector-verified.json
```

Para un subconjunto: agregar `--only` con identificadores separados por comas. Las credenciales se toman de la configuración local y no se escriben en los resultados.
