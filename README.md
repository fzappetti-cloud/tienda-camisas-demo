# Tienda de camisas con marca propia – Demo interactiva

Demo visual (un solo archivo HTML, sin dependencias) del sistema "llave en mano":
tablero operativo + escáner de distribuidoras + estudio de imagen + precios + publicación en Tiendanube + pedidos.

## Ver la demo
Abrir `demo/index.html` en el navegador.

## Flujo de trabajo
- `main`: versión estable de la demo.
- Una rama por cambio (`git checkout -b mejora-escaner`) y se mezcla a `main` cuando está pulido.

## Pendiente (ver proyecto)
- Pulir textos y diseño con marca de la clienta.
- Siguiente hito: esqueleto real (React + Node + extensión Chrome).

Nota: las fotos de terceros son responsabilidad de la clienta; la demo usa dibujos de ejemplo.


## Carga del catálogo en 2 pasos (GitHub Actions)
1. **"1 · Buscar tipos de prenda"**: lee solo la portada de cada tienda (1 pedido por tienda) y guarda `data/categories.json`. No toca el catálogo.
2. **"2 · Cargar catálogo de lo seleccionado"**: en el tablero se tildan los tipos de prenda y se usa "Copiar selección para cargar"; esa selección se pega al correr este workflow (campo `seleccion`) y se guarda en `data/config.json`. Trae **solo** esas categorías (si no se tilda ninguna, trae todo lo que encuentra) y **coteja los talles que ella ofrece** (`talles` en la selección): descarta productos sin ningún talle elegido disponible y conserva solo los talles coincidentes. Corre solo una vez por día con la última selección.

## Pegar el enlace de un producto (alternativa a la búsqueda por tipos)
La clienta puede copiar el enlace de una prenda que vio en la distribuidora y pegarlo en el tablero. El sistema lee solo esa página (1 pedido):
`node scraper/sync.js producto https://www.vintagebsas.com.ar/productos/<producto>/` devuelve nombre, foto, precio, talles disponibles y los productos relacionados que la tienda sugiere.
Importante: en estas páginas el JSON-LD (datos para Google) pertenece a los productos relacionados; el principal se lee de `og:title`, `og:image` y el bloque `#single-product`.
Solo se aceptan enlaces de productos de las tiendas conocidas (`https`, `/productos/<slug>/`). En el demo, el campo busca el enlace dentro del catálogo ya guardado; la lectura real de la página se hace en el servidor.
