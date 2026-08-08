# Stocky — Plan de rediseño y nuevas features

> Contexto para quien ejecute esto (Cursor): Stocky es un sistema de gestión de stock por voz/WhatsApp para una tienda de camisetas de fútbol replica (FullMatch). Backend Node.js (Render), frontend Vite/React (Vercel), DB Supabase, integración WhatsApp vía Meta Cloud API. El dueño (único usuario) carga stock hablándole por WhatsApp, y ve todo en un dashboard web.

---

## 0. Rename

- El sistema se llama **Stocky**, no ERPVoice. Cambiar el nombre en el header del dashboard, título de la página, y cualquier lugar visible del front. (Nombres internos de repo/DB no hace falta tocarlos si generan trabajo innecesario — priorizar lo visible al usuario.)

---

## 1. Dashboard principal (rediseño)

**Problema actual:** 4 cards (Valor Inventario, Productos, Deuda Total, Clientes) + tabla de "Últimas Transacciones" línea por línea + sección "Cuentas Corrientes" vacía. Mucho ruido, poca señal.

**Cambios:**
- Sacar las cards "Deuda Total" y "Clientes/Cuentas Corrientes" del resumen (no se usa ese flujo; si se necesita más adelante, reevaluar tras implementar el módulo de clientes/pedidos del punto 3).
- Agregar una card nueva de **"Stock bajo / agotado"**: contador de productos con 0 o poco stock, con link directo a esos productos.
- Mantener "Valor Inventario" y "Stock Disponible" como cards principales.
- **Agrupar el feed de actividad**: hoy cada carga por voz que menciona varios productos genera una línea por producto, todas con el mismo timestamp casi exacto. Agrupar por "sesión de carga" (mismo mensaje/audio de origen) y mostrar colapsado: "Carga por voz — 5 items — [fecha/hora]", expandible para ver el detalle. Investigar la forma más simple de agrupar (por ejemplo, mismo `wamid`/id de mensaje de origen si ya se guarda, o timestamp dentro de una ventana de pocos segundos).

---

## 2. ABM de productos (rediseño)

**Problema actual:** cada variante de talle de un mismo modelo es una fila separada y repite nombre completo del producto en cada una (7 filas para "Camiseta Argentina Titular 2026" con sus 7 talles). Mucho scroll, difícil de escanear.

**Cambios:**
- Colapsar por default: mostrar una fila por modelo ("Camiseta Argentina Titular 2026 — 7 talles — 7 disponibles"), expandible al hacer click.
- Dentro del grupo expandido, mostrar los talles como chips/badges en una sola línea con su stock (`S:1 M:1 L:1 XL:1 2XL:1 3XL:1 4XL:1`) en vez de una fila por talle.
- Edición inline: click en el número de stock o en el precio para editarlo ahí mismo, sin abrir un formulario/modal aparte.
- Mantener el botón "+ Nuevo Producto" tal como está si ya funciona bien.

---

## 3. Módulo de Clientes + Pedidos (feature nueva)

**Objetivo:** llevar un anotador de "quién me pidió qué" para tenerlo en cuenta al hacer pedidos a los proveedores. **No es un sistema de reservas ni de venta** — que alguien pida algo no garantiza que se consiga, y marcar un pedido como resuelto **no debe descontar stock automáticamente**.

**Contexto clave del negocio:** el sistema es unipersonal. Los clientes le escriben directamente a Lucas (el dueño) por WhatsApp/en persona, y es **Lucas** quien le escribe a Stocky para registrar el pedido. El sistema nunca tiene contacto con el cliente ni con su número de teléfono. Por lo tanto:
- No hay teléfono de cliente en el modelo de datos.
- El matching de cliente es **solo por nombre**, tal como lo dice Lucas al hablarle al sistema.

### 3.1 Modelo de datos (sugerido, ajustar según convenga en Supabase)

**Tabla `clientes`**
- `id`
- `nombre`
- `notas` (opcional, texto libre)

**Tabla `pedidos`**
- `id`
- `cliente_id` (FK a clientes)
- `producto` (texto libre o FK a producto/modelo del catálogo si conviene linkearlo)
- `talle`
- `estado`: `pendiente` / `conseguido` / `descartado`
- `fecha_pedido`
- `notas` (opcional)

### 3.2 Carga por voz/WhatsApp

Debe poder cargarse igual que el stock hoy, ej: *"Juan me pidió una camiseta de Boca titular talle M"*.

El parser tiene que poder **distinguir un pedido de cliente de un ingreso de stock** (hoy el parser probablemente solo está pensado para altas de stock — este es el punto más delicado a resolver técnicamente, investigar mejor forma de extender el prompt/lógica actual sin romper el flujo de stock existente).

**Matching de nombre de cliente:**
- Búsqueda case-insensitive y sin tildes contra clientes existentes.
- Si matchea uno solo → usar ese cliente.
- Si es ambiguo o no existe → crear cliente nuevo directo (no bloquear la carga por voz pidiendo confirmación). Los duplicados que se generen se resuelven después a mano.

### 3.3 ABM de Clientes (dashboard web)

- Listado simple de clientes con sus pedidos asociados.
- Función para **fusionar clientes duplicados** (ej. "Juan" y "juan perez" resultan ser la misma persona) — mergear sus pedidos al fusionar. No es crítico para la v1, pero dejarlo contemplado.

### 3.4 Vista de Pedidos pendientes (la pantalla más importante de este módulo)

Vista agrupada por **producto + talle**, mostrando quién lo pidió, para poder mirarla al armar un pedido a proveedor. Ejemplo:

- Camiseta Boca Titular — M — 2 pedidos (Juan, María)
- Camiseta River Suplente — S — 1 pedido (Pedro)

Filtro por estado (pendiente / conseguido / descartado) y acción rápida para cambiar el estado de un pedido desde ahí mismo.

---

## Prioridad sugerida

1. Rename a Stocky (rápido, bajo impacto)
2. Modelo de datos + ABM de Clientes/Pedidos (funcionalidad nueva, el core de lo que falta)
3. Vista de Pedidos pendientes agrupada
4. Integración con voz/WhatsApp para carga de pedidos
5. Rediseño de dashboard principal
6. Rediseño de ABM de productos (colapsado + inline edit)

(Los puntos 5 y 6 son mejoras de UX sobre algo que ya funciona; los puntos 2-4 son la funcionalidad que hoy no existe y la que más valor agrega.)
