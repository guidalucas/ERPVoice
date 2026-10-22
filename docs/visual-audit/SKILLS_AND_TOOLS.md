# Skills y herramientas evaluadas

**Fecha:** 22/10/2026. **Instalaciones realizadas:** ninguna.

## Descubrimiento real de capacidades

Se revisó el catálogo de skills provisto por el entorno y el directorio `C:/Users/lucas/.agents/skills`. Se buscaron herramientas de navegador/captura por su nombre y descripción en `ALL_TOOLS`. `package.json` y `node_modules` confirmaron Playwright existente; Windows tenía Edge instalado. No se asumió una skill por su nombre ni se añadieron herramientas para aumentar el inventario.

| Skill leída | Procedencia real | Evaluación y uso |
|---|---|---|
| computer-use | [SKILL.md](C:/Users/lucas/.codex/plugins/cache/openai-bundled/computer-use/26.1016.51333/skills/computer-use/SKILL.md) | Leída para identificar capacidades Windows. Se consultó inventario CUA de navegadores: in-app browser sin pestañas y MCP Apps; ninguna sesión privada autorizada disponible. No se controlaron apps nativas mediante Sky. Se prefirió Playwright explícitamente solicitado |
| canvas | [SKILL.md](C:/Users/lucas/.agents/skills/canvas/SKILL.md) | Leída para evaluar presentación de resultados. La propia skill excluye entregables específicos; se respetó la solicitud de Markdown y capturas en el repositorio, sin crear un canvas adicional |
| visualize | [SKILL.md](C:/Users/lucas/.codex/plugins/cache/openai-bundled/visualize/1.0.55/skills/visualize/SKILL.md) | Leída para decidir formato de propuesta. Distingue archivos solicitados de visualización inline; no se usó runtime inline. Se produjeron diagramas documentales SVG/PNG |
| game-ui-frontend | [SKILL.md](C:/Users/lucas/.codex/plugins/cache/openai-curated-remote/game-studio/0.1.2/skills/game-ui-frontend/SKILL.md) | Se verificó contenido: orientada a HUDs/menús de juegos y protección de playfield. No pertinente para auditar un SaaS/ecommerce. No se aplicaron sus patrones específicos |

No se halló una skill instalada general de UI audit, frontend design SaaS, accesibilidad o responsive audit. Las skills de Sites, imagegen, game-playtest, Render y revisión de seguridad no se invocaron: esta tarea no solicita construir/publicar un sitio, generar fotos, probar un juego ni auditar infraestructura. No era necesario instalar una skill para obtener capturas, medidas y referencias con las herramientas existentes.

## Herramientas utilizadas y límites

| Herramienta | Uso real | Qué no demuestra |
|---|---|---|
| Playwright existente + Edge headless instalado | Navegación real, viewports, focos/hover, formularios, selección y screenshots PNG; popup de galería; intercepción de error/retardo solo local | Un viewport no reproduce Safari/touch/teclado físico; no es certificación WCAG |
| CUA `getState` | Comprobar superficies/sesiones disponibles | No encontró una cuenta privada del comercio |
| `view_image` | Inspección efectiva de screenshots y diagramas guardados | El DOM o una medición sin imagen no reemplazan revisión visual |
| Navegación/búsqueda web | Referencias actuales, documentación oficial y criterios W3C | Un texto indexado no prueba que se haya visto la estética de una página bloqueada |
| Fixture existente `startCommerceFixture` | Base PostgreSQL nueva temporal, API y Vite en localhost, usuarios/productos/arte descartables | No replica exactamente producción ni tiene fotos comerciales reales |
| `sharp`, ya instalado | Arte de fixture rotulado; render de diagramas SVG propios y planchas de capturas para revisión | No se retocaron ni generaron fotografías reales del comercio |
| Estilos computados + geometría DOM | Ancho de filtros, posición de productos, fuente declarada, colores de ayudas/botones; detección orientativa de overflow/imágenes | La familia declarada no demuestra que Inter esté cargada; elementos de menos de 44 px no implican por sí solos fallo WCAG AA |
| Fórmula de luminancia sRGB | Ratios concretos 2,92:1, 6,47:1 y 3,52:1 | No valida automáticamente todos los estados o combinaciones de marca |
| `rg`, lectura de fuentes y git | Rutas reales, responsables React/CSS, baseline de cambios | No se convirtió la tarea en auditoría de arquitectura/backend |

## Incidencias del entorno

El lanzamiento de navegador y PostgreSQL dentro del sandbox Windows falló por permisos de archivos/procesos. Se ejecutaron las herramientas existentes fuera del sandbox mediante la escalación revisada del entorno. No se deshabilitó autenticación, antivirus, validación TLS ni barreras de los sitios. No hubo rechazo de aprobación que dejara una acción pendiente.

La primera importación ESM de Playwright en el REPL no expuso el export esperado; la ejecución final usa Node y el paquete instalado. Algunos selectores exploratorios se corrigieron al contrastar la UI: nombres móviles sin números, cierre real de sesión local y selección por nombre en lugar de orden de productos. Los archivos finales identifican el estado capturado real, no un intento fallido. Dos trabajos exploratorios de benchmark terminaron parcialmente ante un enlace superpuesto o una barrera; sus resultados utilizables se complementaron con capturas posteriores, sin atribuirles navegación completa.

## Herramientas consideradas, no instaladas

- **axe / axe-playwright:** útil para una fase de accesibilidad automatizada; no necesaria para demostrar filtros truncados, contraste concreto o estados observados. La evaluación actual no debe presentarse como un informe axe.
- **Lighthouse / DevTools de rendimiento:** útiles para performance percibida, pero fuera del núcleo de diagnóstico visual. No hay métricas de Core Web Vitals en esta entrega.
- **Regresión visual con baselines de Playwright:** útil tras aprobar e implementar el diseño. Ahora solo existe baseline de evidencia, no tests que certifiquen un rediseño.
- **Extensiones del navegador y skills remotas:** no aportaban una capacidad indispensable ausente. Se evitó conceder permisos o instalar paquetes adicionales.

No se ejecutaron scripts remotos ni se otorgaron permisos a nuevas extensiones. La autorización adicional de investigar herramientas gratuitas se utilizó para evaluar necesidad, no como obligación de instalar.

## Reproducción acotada

Desde la raíz del repositorio, con Node, Playwright, Edge y dependencias existentes:

```powershell
node docs/visual-audit/capture-audit.mjs production
node scripts/dev-commerce-fixture.js
```

Con el fixture en ejecución, en otra terminal:

```powershell
node docs/visual-audit/capture-audit.mjs studio
node docs/visual-audit/capture-audit.mjs states
node docs/visual-audit/capture-audit.mjs measurements
node docs/visual-audit/capture-audit.mjs branding
node docs/visual-audit/capture-audit.mjs states-extra
```

`branding` y `states-extra` escriben solo en el fixture descartable: portada de prueba/restauración de apariencia y segunda foto de prueba. `multirubro` inicia y limpia su propio fixture y crea productos/negocios únicamente allí:

```powershell
node docs/visual-audit/capture-audit.mjs multirubro
node docs/visual-audit/capture-audit.mjs benchmark
node docs/visual-audit/capture-audit.mjs references-extra
node docs/visual-audit/capture-audit.mjs admin-docs
node docs/visual-audit/generate-review-assets.mjs
```

Los scripts exploratorios se conservan como fuente de evidencia, no como suite CI. Las referencias externas cambian y pueden bloquear automatización. `benchmark-deep` es un recorrido exploratorio parcial; para la ficha Nike válida se utilizó `references-extra` con URL obtenida del enlace real. No ejecutarlo como criterio de aceptación automatizado.

El helper existente prepara el esquema **exclusivamente en una base nueva temporal**, con claves de integraciones externas desactivadas y bind localhost. No se aplicaron migraciones a ninguna base productiva/existente. La sesión de prueba queda en el runtime ignorado, nunca en esta documentación. Para detener el fixture principal usar Ctrl+C o crear su archivo `FIXTURE_STOP`, como indica el script; la auditoría lo detiene al terminar.

## Evidencia y procedencia

- `screenshots/`: capturas originales de navegador; prefijos `prod`, `local`, `ref`.
- `evidence/*.json`: URL, texto renderizado y medidas; sin tokens ni connection strings.
- `SCREENSHOT_INDEX.md` y `evidence/manifest.json`: trazabilidad y hash SHA-256 por captura.
- `wireframes/`: diagramas propios conceptuales y PNG derivados. No son capturas de aplicación.
- `contact-sheets/`: reducciones de capturas para revisión; originales íntegros en screenshots.

Las fechas de observación se registran como 22/10/2026 en Uruguay; los JSON de origen incluyen puertos efímeros. La captura prueba el resultado de esa navegación, no la permanencia del diseño o del contenido.

## Validación final de la entrega

Se verificaron 332 enlaces locales sin destinos faltantes y 118 PNG con hashes SHA-256 coincidentes. Doce capturas registran barreras de acceso externas y no cuentan como interfaces comerciales inspeccionadas. La entrega contiene 22 hallazgos, 23 ítems de backlog y tres wireframes. Los JSON de evidencia se pudieron leer y no contienen tokens Bearer ni connection strings. El fixture principal está detenido y su archivo de sesión fue eliminado por el helper. Git solo muestra archivos nuevos dentro de `docs/visual-audit/`; no se alteraron archivos productivos. Resultado reproducible en `evidence/validation.json`.
