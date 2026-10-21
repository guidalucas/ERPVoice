# Etapa 4 — evolución comercial sin transacciones reales

Base validada: `1d63a74`. El alcance útil de esta etapa es un carrito local de consulta con presupuesto orientativo de solo lectura. No se habilitan cobros, pedidos productivos, reservas ni envíos.

## Decisión de plataforma

Mantener por ahora catálogo/Studio propios y agregar una consulta agrupada por WhatsApp. Esto reutiliza la única autoridad de stock y evita introducir un segundo checkout antes de confirmar país, moneda, cobro, entrega y operación comercial.

[Empretienda](https://empretienda.com/funcionalidades/) ya ofrece pagos, envíos, promociones y contacto comercial. Reutilizar su checkout podría ahorrar desarrollo si se decide conservarlo; en la documentación pública revisada no se verificó un contrato de API de sincronización suficiente para prometer integración automática. No afirmar que no existe: confirmar con el proveedor antes de decidir una migración.

[Shopify InventoryLevel](https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryLevel) expone cantidades por ítem y ubicación; su [documentación de webhooks](https://shopify.dev/docs/api/webhooks/latest) ofrece eventos para integrar sistemas. Adoptarlo exigiría mapear SKU/ubicaciones, credenciales y reconciliación de movimientos para evitar dos autoridades de inventario. Esa es una integración distinta del catálogo ya construido.

[WooCommerce Store API](https://developer.woocommerce.com/docs/apis/store-api/) ofrece productos, carrito y checkout públicos, con sesiones y protección de operaciones de escritura. Incorporarlo agregaría una plataforma WordPress/PHP y su mantenimiento al stack Node/PostgreSQL existente. No aporta una ventaja necesaria para este prototipo de consulta.

La decisión actual es reversible. Evaluar proveedor/checkout cuando existan volumen real, medios de pago y entrega definidos, presupuesto de mantenimiento y un contrato probado de sincronización/idempotencia. No se comparan precios de planes sin esas decisiones ni se contrata un servicio.

## Carrito de consulta

El navegador conserva solo slug público, talle y cantidad, por catálogo. Hasta veinte líneas y diez unidades por línea. No almacena datos personales ni importes como autoridad. Se agrega desde cada ficha y se gestiona en `/c/:shop/consulta`.

`POST /api/catalog/v1/:shop/inquiry-preview` recibe `items` y un `previousFingerprint` opcional. Valida catálogo/publicación/preparación vigentes, identifica la variante activa dentro de la ficha y calcula precio/subtotal/total con aritmética entera. La transacción es `READ ONLY REPEATABLE READ` y no genera recibos, pedidos, movimientos ni reservas. Rechaza precios/propietarios/SKU internos enviados por el cliente.

Responde solo datos comerciales permitidos, disponibilidad suficiente para la cantidad solicitada, total orientativo, huella semántica y enlace de contacto configurado. No devuelve saldo/reserva exactos ni IDs operativos. Si una línea ya no está disponible, conserva la consulta para corregirla y bloquea la continuación grupal.

Antes del pase a WhatsApp, el navegador vuelve a consultar. Si cambian datos relevantes, muestra el resumen nuevo y exige otra acción del cliente para continuar. La navegación final se produce únicamente después de un clic explícito; no se envían mensajes desde backend. La prueba intercepta ese destino localmente y nunca contacta una cuenta real.

## Aceptación

Comprobar importes exactos, cantidad neta sin descontar reservas dos veces, rechazo de cuerpos manipulados y líneas duplicadas, productos ocultos/negocios ajenos, cambios de precio/stock antes del contacto, conservación local al recargar y cero modificaciones de inventario/pedidos/recibos. Verificar escritorio/móvil, aislamiento por catálogo y que el único destino externo sea el WhatsApp comercial permitido. Repetir regresiones públicas/privadas y builds antes del cierre autorizado.
