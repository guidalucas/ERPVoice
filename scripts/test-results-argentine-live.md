# Pruebas de Stocky con lenguaje argentino

Ejecución: 20 de octubre de 2026, 5:35 p. m. a 20 de octubre de 2026, 5:40 p. m. (America/Montevideo).

Modelo real: **gemini/gemini-3.5-flash-lite**. Código del intérprete y ejecutores locales, conectado a Supabase de producción.

## Resultado

- Primera pasada: **20/24 correctos**; 4 fallos.
- Se repitieron únicamente los cuatro fallidos, una vez: **1/4 correctos**.
- **3 fallos se repitieron y 1 fue intermitente**. Los casos que pasaron de primera no se repitieron, por lo que esta batería no mide su tasa de intermitencia.
- **32 llamadas** en total: 27 en la batería, 4 en la repetición y 1 en el piloto. Una llamada a la vez, pausas mínimas de 6 segundos dentro de cada pasada, sin reintentos automáticos ni proveedores alternativos.
- Tokens registrados en batería y repetición: 206.509 de entrada y 6.345 de salida.

## Cómo se usó producción

Se leyó una copia de 31 productos activos del catálogo real y se agregaron 11 variantes sintéticas de ropa, dos clientes ficticios y un proveedor ficticio. Los casos incluyeron remeras, shorts, buzos, camperas, polleras, tops, medias, pantalones cargo, musculosas, calzas y camisetas.

Las escrituras ocurrieron en tablas temporales de esa misma base. Cada confirmación se ejecutó con los validadores, el ejecutor universal y la persistencia de historial de la aplicación; luego se hizo rollback del escenario. No se actualizaron filas permanentes de negocios reales ni se enviaron mensajes de WhatsApp. Se verificó que las tablas resueltas por el ejecutor fueran temporales y se impidió el acceso por search_path a las tablas públicas durante las escrituras.

Limpieza explícita de tablas temporales al finalizar: batería **verificada**; repetición **verificada**. El piloto necesitó limpieza explícita adicional al detectar que la conexión inicial usaba pooling por transacción. La batería final usó una conexión de sesión, como indica la [documentación de Supabase](https://supabase.com/docs/guides/database/connecting-to-postgres).

## Hallazgos

### 1. Carga conjunta de productos nuevos: intermitencia

La solicitud de dos polleras y tres tops, con precios diferentes en «lucas», produjo INVALID_OPERATION_PLAN en la primera pasada. La misma solicitud pasó en la repetición, incluyendo confirmación e historial. No se pudo atribuir el primer rechazo a un campo concreto porque esa primera respuesta inválida no se había guardado en bruto; el evaluador ahora conserva ese JSON cuando el contrato falla.

### 2. Medias vendidas por par: unidad genérica

En ambas pasadas, cuatro pares se interpretaron con cantidad 4 y precio 4.000 ARS, pero la unidad del producto fue unit en lugar de par. «Talle único» y «único» son equivalentes para esta evaluación; esa diferencia de formato no se considera un error. El fallo que persiste es la pérdida de la unidad declarada.

### 3. Ingreso abreviado: intención y variante ambiguas

«Sumá una remera oversize negra M y un short running azul» devolvió una propuesta lista en ambas pasadas. En la primera eligió stock.sell para los dos productos y tomó M para el short, aunque la frase no declaraba una venta y el short tenía dos talles disponibles. Se esperaba aclarar el alcance antes de proponer cambios. El evaluador detuvo la confirmación al detectar la diferencia.

### 4. Venta y fiado: aclaración innecesaria

En «Vendí 99 camisetas… y a Mica Rojas sumale 5 lucas…», la primera respuesta sostuvo que no encontraba a Mica, aunque estaba en el catálogo ofrecido. La segunda exigió identificar al cliente de la venta. Ese dato no es obligatorio para stock.sell, y el cargo ya identificaba a Mica. El caso no llegó a probar la atomicidad de esa operación porque el modelo no generó un plan listo. El rechazo de una venta individual sin stock sí se verificó.

## Controles que pasaron

- 16 casos confirmaron cambios y comprobaron que repetir la confirmación no duplicara efectos.
- Ingresos de varias prendas, ventas con precio en lucas, reservas sin confundirlas con ventas, fiado y pagos de clientes.
- Venta y cargo a cuenta en una misma operación, alta y cambio de pedidos, alta de clienta con notas.
- Consulta de variantes y consulta sobre un producto copiado del catálogo real.
- Respuesta corta a una venta ambigua y respuesta «talle L» para dos productos sin repetir la pregunta.
- Corrección «Pará, fue uno solo», precio cero, omisión de precios opcionales y cancelación sin efectos.
- Rechazo de una venta de 99 unidades contra solo 3 disponibles, con rollback comprobado.

## Límites de esta batería

Se probaron interpretación, contratos, borradores, revisión de WhatsApp, confirmación, escritura, historial e idempotencia con datos temporales. No se probaron envío real de WhatsApp, transcripción de audio, interfaz web ni el código desplegado en Render. Las tablas LIKE copiaron columnas, valores por defecto, restricciones CHECK e índices de producción; PostgreSQL no copia sus claves foráneas, políticas RLS ni triggers con LIKE. Por eso esta prueba no valida esas tres capas.

## Casos completos

### 01-remeras-coloquial — Ingreso

Primera pasada: **CORRECTO**.

> Che, entraron tres remeras oversize negras talle L. Sumalas nomás.

### 02-short-y-buzo — Ingreso

Primera pasada: **CORRECTO**.

> Me llegaron 2 shorts running azules M y 1 buzo frisa gris XL, metelos al stock.

### 03-polleras-y-tops-nuevos — Productos nuevos

Primera pasada: **FALLÓ**. Repetición: **CORRECTO**.

> Cargame como productos nuevos dos polleras plisadas beige talle 2 y tres tops acanalados chocolate talle único. Las polleras van a 32 lucas pesos argentinos y los tops a 18 lucas pesos argentinos.

Error inicial: Se esperaba ready; recibido invalid: INVALID_OPERATION_PLAN 'invalid' !== 'ready'

### 04-campera-jean — Productos nuevos

Primera pasada: **CORRECTO**.

> Agregá al inventario una campera de jean nueva, azul, talle S, a 58.500 pesos argentinos.

Productos creados en la prueba: Campera de jean nueva, S, 1 disponibles, 58.500 ARS.

### 05-medias-por-par — Productos nuevos

Primera pasada: **FALLÓ**. Repetición: **FALLÓ**.

> Entraron 4 pares de medias lisas negras talle único, nuevas, y cada par sale 4 lucas pesos argentinos. Cargalas al stock.

Error inicial: Talle nuevo incorrecto. + actual - expected + 'talle unico' - 'unico'

Error repetido: Se perdió la unidad par: unit

### 06-venta-lucas — Venta

Primera pasada: **CORRECTO**.

> Se fueron dos remeras oversize negras L, cobré 25 lucas pesos argentinos cada una. Registrá la venta.

### 07-reserva-sin-venta — Reserva

Primera pasada: **CORRECTO**.

> Guardame un short running azul talle M para mañana. Reservalo nomás, todavía no lo vendí.

### 08-fiado-mica — Cuenta corriente

Primera pasada: **CORRECTO**.

> A Mica Rojas anotale 35 lucas en la cuenta por las prendas que se llevó fiadas.

Saldos finales verificados antes del rollback: Mica Rojas: 45.000.

### 09-pago-bauti — Cuenta corriente

Primera pasada: **CORRECTO**.

> Bauti Pérez me pasó 12 lucas, descontáselas de lo que debe.

Saldos finales verificados antes del rollback: Bauti Pérez: 18.000.

### 10-venta-y-fiado — Operación mixta

Primera pasada: **CORRECTO**.

> Se vendió una campera rompeviento negra M y a Mica Rojas sumale 48 lucas que quedó debiendo.

Saldos finales verificados antes del rollback: Mica Rojas: 58.000.

### 11-pedido-cargo — Pedido

Primera pasada: **CORRECTO**.

> Anotale a Bauti Pérez un pedido de dos pantalones cargo verdes talle 44 con Textil Sur; dejalo pendiente.

### 12-corregir-pedido — Pedido

Primera pasada: **CORRECTO**.

> El pedido pendiente de Mica Rojas por la calza ciclista negra M dejalo en tres, que me pidió dos más.

### 13-consulta-variantes — Consulta

Primera pasada: **CORRECTO**.

> ¿Cuántas remeras oversize negras talle L me quedan? Decime también las M.

### 14-venta-ambigua-y-respuesta — Aclaración

Primera pasada: **CORRECTO**.

> Vendí una remera oversize negra.

Respuesta/corrección: «La L».

### 15-talle-para-grupo — Aclaración grupal

Primera pasada: **CORRECTO**.

> Entraron dos shorts running azules y dos remeras oversize negras. Sumalos al stock.

Respuesta/corrección: «talle L».

### 16-conservar-talle-previo — Aclaración parcial

Primera pasada: **FALLÓ**. Repetición: **FALLÓ**.

> Sumá una remera oversize negra M y un short running azul.

Error inicial: Se esperaba clarification; recibido ready + actual - expected + 'ready' - 'clarification'

Error repetido: Se esperaba clarification; recibido ready + actual - expected + 'ready' - 'clarification'

### 17-rectificar-cantidad — Corrección

Primera pasada: **CORRECTO**.

> Vendí dos buzos frisa grises XL.

Respuesta/corrección: «Pará, fue uno solo. Me confundí.».

### 18-no-pedir-precio-opcional — Ingreso

Primera pasada: **CORRECTO**.

> Me llegaron dos musculosas deportivas blancas S y no sé a cuánto venderlas todavía. Sumalas.

### 19-precio-cero — Precio

Primera pasada: **CORRECTO**.

> La calza ciclista negra M va gratis en la promo, dejale el precio en cero pesos argentinos.

### 20-stock-insuficiente — Validación

Primera pasada: **CORRECTO**.

> Vendí 99 camisetas Barrio Norte titular 2026 talle L.

Rechazo esperado del backend: INSUFFICIENT_STOCK; estado restaurado por rollback.

### 21-mixta-sin-stock-atomica — Atomicidad

Primera pasada: **FALLÓ**. Repetición: **FALLÓ**.

> Vendí 99 camisetas Barrio Norte titular 2026 talle L y a Mica Rojas sumale 5 lucas a su cuenta por esa compra fiada.

Error inicial: Se esperaba ready; recibido clarification: No se encontró ningún cliente o cuenta coincidente con 'Mica Rojas' para realizar el cargo. + actual - expected + 'clarification' - 'ready'

Error repetido: Se esperaba ready; recibido clarification: Por favor, especificá a qué cliente corresponde la venta y el saldo a cobrar, ya que no se indicó un cliente para la venta de las camisetas y hay más de un cliente registrado en el sistema. + actual - expected + 'clarification' - 'ready'

### 22-alta-clienta — Cliente

Primera pasada: **CORRECTO**.

> Dame de alta a Cami Fernández como clienta, dejá anotado que retira por el local.

### 23-cancelar-carga — Cancelación

Primera pasada: **CORRECTO**.

> Che, entraron tres remeras oversize negras talle L.

### 24-consulta-catalogo-produccion — Catálogo real

Primera pasada: **CORRECTO**.

> Decime cuánto stock disponible y reservado tengo del producto "Camiseta Argentina suplente 2026 versión jugador", talle M.

## Repetir la batería

```powershell
node --use-system-ca scripts/evaluate-argentine-production.js --live --production-temp --out scripts/test-results-argentine-live.json
```

Se requiere la configuración local de la base y del proveedor. Las credenciales no se escriben en el informe. La opción --only permite repetir identificadores concretos separados por comas sin ejecutar todo el corpus.
