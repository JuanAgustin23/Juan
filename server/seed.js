'use strict';
// Datos iniciales de la DEMO.
// - Productos: tomados de la lista entregada por el local.
// - Precios: de PRUEBA (price_is_test = 1). No son los precios reales.
// - Descripciones e ingredientes: PROVISIONALES. Solo se marca como no provisional
//   un ingrediente que se deduce literalmente del nombre del producto
//   (p. ej. "queso" en "Empanaditas de queso"). Todo lo demás debe confirmarlo el local.
// - Bebidas: productos de ejemplo (is_placeholder = 1) para reemplazar por las reales.

// i(nombre, { core: no se puede quitar, known: se deduce del nombre })
const i = (name, opts = {}) => ({ name, removable: !opts.core, provisional: !opts.known });

const COMPLETO_ITALIANO = [i('Pan de completo', { core: true }), i('Vienesa', { core: true }), i('Tomate'), i('Palta'), i('Mayonesa')];
const COMPLETO_DINAMICO = [i('Pan de completo', { core: true }), i('Vienesa', { core: true }), i('Tomate'), i('Palta'), i('Mayonesa'), i('Chucrut'), i('Salsa americana')];
const ASS = [i('Pan', { core: true }), i('Carne', { core: true }), i('Tomate'), i('Palta'), i('Mayonesa')];
const CHORRILLANA = [i('Papas fritas', { core: true }), i('Carne', { core: true }), i('Cebolla'), i('Huevo')];
const PAPAS = [i('Papas fritas', { core: true, known: true }), i('Sal')];

const CATEGORIES = [
  {
    name: 'Papas fritas',
    products: [
      { name: 'Papas fritas chicas', price: 2000, illus: 'papas-chicas.svg', desc: 'Porción chica de papas fritas.', ing: PAPAS },
      { name: 'Papas fritas medianas', price: 3000, illus: 'papas-medianas.svg', desc: 'Porción mediana de papas fritas.', ing: PAPAS },
      { name: 'Papas fritas grandes', price: 4500, illus: 'papas-grandes.svg', desc: 'Porción grande de papas fritas.', ing: PAPAS },
    ],
  },
  {
    name: 'Completos',
    products: [
      { name: 'Completo italiano normal', price: 2500, illus: 'italiano.svg', desc: 'Completo con tomate, palta y mayonesa (receta típica chilena, por confirmar con el local).', ing: COMPLETO_ITALIANO },
      { name: 'Completo italiano grande', price: 3500, illus: 'italiano.svg', desc: 'Versión grande del completo italiano (receta típica chilena, por confirmar con el local).', ing: COMPLETO_ITALIANO },
      { name: 'Completo dinámico normal', price: 2800, illus: 'dinamico.svg', desc: 'Completo con varios agregados. Los agregados exactos están por confirmar con el local.', ing: COMPLETO_DINAMICO },
      { name: 'Completo dinámico grande', price: 3800, illus: 'dinamico.svg', desc: 'Versión grande del completo dinámico. Agregados por confirmar con el local.', ing: COMPLETO_DINAMICO },
    ],
  },
  {
    name: 'Sándwiches',
    products: [
      { name: 'ASS normal', price: 4500, illus: 'ass.svg', desc: 'Sándwich de carne. Ingredientes por confirmar con el local.', ing: ASS },
      { name: 'ASS grande', price: 5900, illus: 'ass.svg', desc: 'Versión grande del ASS. Ingredientes por confirmar con el local.', ing: ASS },
      { name: 'Churrasco Rucka Monkey', price: 6500, illus: 'churrasco.svg', desc: 'Churrasco de la casa. Ingredientes por confirmar con el local.', ing: [i('Pan', { core: true }), i('Churrasco de carne', { core: true }), i('Tomate'), i('Palta'), i('Mayonesa')] },
    ],
  },
  {
    name: 'Para compartir',
    products: [
      { name: 'Chorrillana chica', price: 7900, illus: 'chorrillana.svg', desc: 'Papas fritas con carne y agregados. Ingredientes por confirmar con el local.', ing: CHORRILLANA },
      { name: 'Chorrillana grande', price: 12900, illus: 'chorrillana.svg', desc: 'Versión grande de la chorrillana. Ingredientes por confirmar con el local.', ing: CHORRILLANA },
      { name: 'Fajitas', price: 5500, illus: 'fajitas.svg', desc: 'Tortillas con relleno. Relleno por confirmar con el local.', ing: [i('Tortilla', { core: true }), i('Carne'), i('Pimentón'), i('Cebolla')] },
      { name: 'Quesadillas', price: 4500, illus: 'quesadillas.svg', desc: 'Tortillas con queso. Otros ingredientes por confirmar con el local.', ing: [i('Tortilla', { core: true }), i('Queso', { core: true, known: true })] },
      { name: 'Empanaditas de queso', price: 3500, illus: 'empanaditas.svg', desc: 'Empanaditas rellenas de queso. Cantidad por porción por confirmar.', ing: [i('Masa', { core: true }), i('Queso', { core: true, known: true })] },
      { name: 'Aros de cebolla', price: 3000, illus: 'aros.svg', desc: 'Aros de cebolla fritos. Tipo de apanado por confirmar.', ing: [i('Cebolla', { core: true, known: true }), i('Apanado', { core: true })] },
    ],
  },
  {
    name: 'Bebidas',
    products: [
      { name: 'Bebida en lata (ejemplo)', price: 1200, illus: 'lata.svg', desc: 'Opción provisional: reemplazar por las bebidas reales del local.', placeholder: true, ing: [] },
      { name: 'Bebida 1,5 L (ejemplo)', price: 2500, illus: 'botella.svg', desc: 'Opción provisional: reemplazar por las bebidas reales del local.', placeholder: true, ing: [] },
      { name: 'Agua mineral (ejemplo)', price: 1000, illus: 'agua.svg', desc: 'Opción provisional: reemplazar por las bebidas reales del local.', placeholder: true, ing: [] },
      { name: 'Jugo (ejemplo)', price: 1300, illus: 'jugo.svg', desc: 'Opción provisional: reemplazar por las bebidas reales del local.', placeholder: true, ing: [] },
    ],
  },
];

const SETTINGS = {
  business_name: 'Rucka Monkey',
  demo_mode: '1',
  bank_is_test: '1',
  bank_holder: 'DATOS DE PRUEBA — NO TRANSFERIR',
  bank_rut: '11.111.111-1',
  bank_name: 'Banco de Prueba',
  bank_account_type: 'Cuenta corriente',
  bank_account_number: '000000000',
  bank_email: 'pagos@ejemplo.cl',
  public_url: '',
  order_counter: '0',
};

function run(db) {
  db.exec('BEGIN');
  try {
    const setS = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(SETTINGS)) setS.run(k, v);

    const insC = db.prepare('INSERT INTO categories (name, sort) VALUES (?, ?)');
    const insP = db.prepare(`INSERT INTO products (category_id, name, description, description_provisional, price, price_is_test, illustration, is_placeholder, sort)
                             VALUES (?, ?, ?, 1, ?, 1, ?, ?, ?)`);
    const insI = db.prepare('INSERT INTO ingredients (product_id, name, removable, provisional, sort) VALUES (?, ?, ?, ?, ?)');
    CATEGORIES.forEach((c, ci) => {
      const cid = insC.run(c.name, ci + 1).lastInsertRowid;
      c.products.forEach((p, pi) => {
        const pid = insP.run(cid, p.name, p.desc, p.price, p.illus, p.placeholder ? 1 : 0, pi + 1).lastInsertRowid;
        p.ing.forEach((g, gi) => insI.run(pid, g.name, g.removable ? 1 : 0, g.provisional ? 1 : 0, gi + 1));
      });
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { run };
