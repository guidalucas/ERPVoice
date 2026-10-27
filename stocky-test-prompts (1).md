# Prompts de prueba para el parser de Stocky (multi-rubro, todas las operaciones)

Organizados por **operación** (no todo "cargá"), con variantes de cómo habla la gente en Argentina — voz o texto, con y sin muletillas, con jerga regional, con elipsis (dando por sabido el contexto). Cada bloque después se prueba contra los 6 rubros: indumentaria, calzado, ferretería, electrónica, kiosco, general.

---

## 1. Cargar mercadería / crear producto

- "Compré 10 camisetas de Boca talle M a 45 mil"
- "Me llegaron 20 pares de Air Force blancas número 42"
- "Tengo 50 tornillos autoperforantes de 3/4 para cargar"
- "Metele 15 cargadores tipo C al sistema, 20W, a 8 lucas"
- "Sumá 30 alfajores Jorgito a 900 pesos"
- "Llegó mercadería: 5 mates imperiales a 18 mil y 5 termos Lumilagro a 25 mil"
- **Listado largo + cierre diferido**: dictar varios productos en mensajes separados ("una remera de River suplente S", "otra de River suplente M", "una de Boca titular L") y después "cargalo al sistema" / "eso es todo, subilo"
- **Producto que no existe todavía (debe crearlo)**: "Cargá camiseta de Vélez alternativa talle L a 55 mil" *(si Vélez no está en el catálogo)*

## 2. Consultar stock

- "¿Cuántas de Argentina hay?"
- **Sigue el hilo (contexto de la pregunta anterior)**: "¿y las de River?" *(inmediatamente después de la anterior, sin repetir "camisetas")*
- "¿Cómo andamos de tornillos de 3/4?"
- "¿Tenés stock de auriculares Bluetooth?"
- "¿Qué me queda de Coca?"
- "Che, ¿hay Air Force en 41?"
- **Consulta ambigua**: "¿cuánto tengo de Boca?" *(si hay Boca titular y Boca suplente, distintos talles — debería aclarar a cuál se refiere o listar todas)*

## 3. Actualizar precio o cantidad

- "Las de Boca ahora valen 50 mil" *(sin talle → debería aplicar a todas las variantes)*
- "Subile el precio a la Nike Air Force blanca a 85 mil"
- "Bajale 5 mil a los tornillos de 3/4"
- "Cambiá el precio del mate imperial a 20 mil"
- "Actualizá la cantidad de cargadores tipo C a 8" *(corrección de stock, no venta)*
- **Ambiguo por variante**: "Subí el precio de la de River" *(si hay varias variantes de River con precios distintos — debería preguntar si aplica a todas o a una)*

## 4. Borrar producto

- "Borrá la de River, no existe"
- "Sacá los tornillos de 1/2, ya no los vendo más"
- "Eliminá el Puma Suede gris"
- "Dale de baja la Coca de litro y medio"
- "Esa camiseta de Vélez está mal cargada, borrala"
- **Ambiguo**: "Borrá la de Boca" *(si hay Boca titular y Boca suplente — no debería borrar ninguna sin confirmar cuál)*

## 5. Ventas

- "Vendí 2 de Argentina talle L"
- "Se llevó una zapatilla Adidas Superstar 39"
- "Salió un mate imperial"
- "Vendí media docena de tornillos 3/4" *(unidad no estándar — "media docena" = 6)*
- "Dos gaseosas Coca de litro"
- **Ambiguo (sin variante)**: "Vendí una de River" *(si hay varias variantes)*
- **Consulta de historial**: "¿cuánto vendí hoy?" / "¿qué vendí esta semana?" / "mostrame las ventas del mes"

## 6. Pedidos (anotador — NO descuenta stock)

- "Juan me pidió una camiseta de Boca talle M"
- "Anotame que María quiere un mate imperial"
- "Pedime 3 tornillos de 3/4 para el cliente de siempre" *(cliente ambiguo, sin nombre concreto — debería preguntar o pedir aclaración)*
- **Consulta**: "¿qué pedidos hay pendientes?" / "¿qué me pidió Juan?"
- **Cambio de estado**: "Marcá como conseguido el pedido de Juan" / "el pedido de María se descartó, ya no lo quiere" / "borrá el pedido de Juan"
- **Cliente nuevo por voz (sin teléfono)**: "Anotame que Pedro pidió una zapatilla 42, es cliente nuevo"

## 7. Clientes, proveedores y deuda

- "Juan me debe 20 mil"
- "Juan me pagó 10 mil"
- "Fusioná a Juan con Juan Pérez, son la misma persona"
- "¿Cuánto me debe María?"
- "Reservame 1 camiseta de Boca para Juan" *(reserva ≠ pedido — sí mueve stock reservado)*
- "Cargá un proveedor nuevo: Distribuidora Sur, notas: entrega los martes"

## 8. Consultas generales / inicio y actividad

- "¿Cómo está el negocio hoy?"
- "¿Qué alertas de stock bajo tengo?"
- "¿Cuál es el valor total del inventario?"
- "Mostrame la actividad de hoy"

---

## Casos transversales (aplican a toda operación y rubro)

- **Sin acción clara**: "Hola, buen día" *(no debería disparar nada)*
- **Multi-acción en un solo mensaje**: "Vendí una de Boca y me llegaron 5 de River nuevas" *(dos operaciones distintas en el mismo mensaje: venta + carga)*
- **Confirmación en el panel (chat flotante)**: el usuario ve la acción detectada y responde "confirmar" / "cancelar" antes de aplicar
- **Aplicación directa en WhatsApp**: mismo mensaje mandado por WhatsApp real — se aplica sin paso de confirmación previo, y el sistema responde después de aplicar
- **Corrección post-resumen**: "no, era talle S, no M"
- **Jerga regional / abreviada**: "dale de baja la de river total no la vendo mas", "chau esa de boca", "sacale un par de mangos al mate"
- **Audio con corte o ruido**: mensaje de voz que se corta a mitad de frase, o con transcripción parcialmente errónea
- **Rubro "general" sin variantes**: probar que el sistema no intente forzar talle/número/medida cuando el producto no tiene esas dimensiones (ej: "combo cumpleaños")
