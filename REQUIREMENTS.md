# Requisitos e instrucciones para ejecutar el proyecto

Resumen corto:
- Node.js (recomendado: >= 18 LTS)
- npm (v9+) o yarn

Dependencias (extraídas de `package.json`):

Dependencias de producción:
- react: ^18.3.1
- react-dom: ^18.3.1

Dependencias de desarrollo:
- @types/node: ^25.9.1
- @types/react: ^18.3.18
- @types/react-dom: ^18.3.5
- @vitejs/plugin-react: ^4.3.4
- autoprefixer: ^10.4.21
- postcss: ^8.5.3
- tailwindcss: ^3.4.17
- typescript: ^5.8.3
- vite: ^6.2.0

Pasos rápidos para preparar el entorno y ejecutar:

1. Instalar Node.js (si no está):

```bash
# Windows: descarga e instala desde https://nodejs.org/
# Recomendado: Node 18 LTS o superior
```

2. Instalar dependencias (desde la raíz del proyecto):

```bash
npm install
# o, si usas yarn:
# yarn
```

3. Ejecutar en modo desarrollo (dev server Vite):

```bash
npm run dev
# luego abre http://localhost:5173 (o la dirección que indique Vite)
```

4. Construir y previsualizar:

```bash
npm run build
npm run preview
```

Notas útiles:
- Hay un archivo de ejemplo de variables de entorno: `.env.example`. Duplica y renómbralo a `.env` si necesitas configurar variables privadas antes de ejecutar.
- El proyecto usa TypeScript y React (`.tsx`) con Vite como bundler y TailwindCSS para estilos.
- Si prefieres un archivo estilo `requirements.txt` para control externo, puedo generar un `package-list.txt` con las dependencias enumeradas.

¿Quieres que también genere un ZIP con los archivos listados o un `package-list.txt` con solo nombres y versiones?
