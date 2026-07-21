import localforage from 'localforage';

localforage.config({
  name: 'FogOfWarDB',
  storeName: 'unlocked_cells'
});

export async function loadUnlockedCells() {
  const cells = await localforage.getItem('hex_set');
  return cells ? new Set(cells) : new Set();
}

export async function saveUnlockedCells(cellSet) {
  await localforage.setItem('hex_set', Array.from(cellSet));
}

export async function clearStorage() {
  await localforage.clear();
}