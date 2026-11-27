import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogIdentity } from '../server/commerce/catalogIdentity.js';

const resolve = (name, productType = 'Camiseta', product = {}) => catalogIdentity(product, [{ name, productType, active: true }]);
test('legacy garment names supply missing team, version and category without using slugs', () => {
  for (const [name, key, label, version] of [
    ['Camiseta Boca Juniors titular 2025 - Versión jugador', 'boca', 'Boca Juniors', 'player'],
    ['Camiseta Suplente De River Plate 2026 - Dorsal Almada', 'river', 'River Plate', null],
    ['Camiseta Selección Argentina titular - Versión Hincha', 'argentina', 'Argentina', 'fan'],
    ['Camiseta del Inter de Miami, versión hincha', 'inter-miami', 'Inter Miami', 'fan'],
    ['Camiseta del Inter suplente 2025 versión jugador', 'inter', 'Inter', 'player'],
    ['Camiseta Genoa homenaje a Boca versión jugador', 'genoa', 'Genoa', 'player'],
    ['Camiseta tercera equipación de la Juventus en versión hincha', 'juventus', 'Juventus', 'fan'],
    ['Camiseta de Vélez 2026 titular', 'velez', 'Vélez', null],
    ['Camiseta de Northbridge titular 2026', 'northbridge', 'Northbridge', null],
    ['River Edición 125 Aniversario', 'river', 'River Plate', null],
  ]) {
    const identity = resolve(name);
    assert.deepEqual([identity.teamKey, identity.teamName, identity.versionKey], [key, label, version], name);
  }
  assert.deepEqual(resolve('Conjunto de abrigo Selección Argentina - Color azul', null).categories, ['Conjunto de abrigo']);
  assert.deepEqual(resolve('Camiseta de Alemania, suplente, 2024', null).categories, ['Camiseta']);
});

test('explicit metadata wins, live active inventory is authoritative, and generic products stay generic', () => {
  const explicit = resolve('Camiseta Boca titular versión hincha', 'Camiseta', { teamKey: 'custom', teamName: 'Equipo revisado', versionKey: 'player' });
  assert.equal(explicit.teamKey, 'custom'); assert.equal(explicit.teamName, 'Equipo revisado'); assert.equal(explicit.versionKey, 'player');
  for (const name of ['Remera de algodón', 'Remera de algodón mangas largas', 'Jean recto', 'Taladro River', 'Camiseta lisa']) {
    const identity = resolve(name, null);
    assert.equal(identity.teamKey, null, name); assert.equal(identity.versionKey, null, name);
  }
  const live = catalogIdentity({ title: 'Camiseta Boca titular versión jugador', slug: 'boca' }, [
    { name: 'Camiseta Boca titular versión jugador', active: false },
    { name: 'Camiseta River titular versión hincha', productType: 'Camiseta', active: true },
  ]);
  assert.equal(live.teamKey, 'river'); assert.equal(live.versionKey, 'fan');
});
