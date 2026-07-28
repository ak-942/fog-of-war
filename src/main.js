import { registerPlugin } from '@capacitor/core';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { latLngToCell, isValidCell } from 'h3-js';
import { FogEngine } from './fogengine.js';

const BackgroundGeolocation = registerPlugin('BackgroundGeolocation');

// --- Configuration Constants ---
// Resolution 11 (~50m hexes). Change to 12 for finer ~20m granularity.
const H3_RESOLUTION = 11; 
const STORAGE_KEY = 'fog_unlocked_cells';
const MAX_IMPORT_HEXES = 200000; // Cap set to 200,000 hexes (~10,000 km of roads)

// --- LocalStorage Persistence Helpers ---
function loadSavedHexes() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? new Set(JSON.parse(saved)) : new Set();
  } catch (e) {
    console.error('Failed to load saved fog data:', e);
    return new Set();
  }
}

function saveHexes(hexSet) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(hexSet)));
  } catch (e) {
    console.error('Failed to save fog data:', e);
  }
}

// --- 1. Map & Fog Engine Setup ---
const map = L.map('map').setView([22.7196, 75.8577], 16);

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap'
}).addTo(map);

const canvas = document.getElementById('fog-canvas');
const fogEngine = new FogEngine(canvas, map);

// App State
let unlockedCells = loadSavedHexes();
let userMarker = null;
let initialCenterDone = false;
let isTrackingActive = true;
let lastPosition = null;

// Initial UI & Fog Render from stored memory
updateUIStats(0);
fogEngine.render(Array.from(unlockedCells));

map.on('move', () => {
  fogEngine.render(Array.from(unlockedCells));
});

// --- Distance Calculation (Haversine Formula in meters) ---
function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// --- 2. Location Update Handler ---
function onLocationUpdate(position) {
  const { latitude, longitude } = position.coords;
  const now = position.timestamp || Date.now();

  // Speed calculation fallback
  let currentSpeedMetersPerSec = position.coords.speed;

  if (lastPosition && (currentSpeedMetersPerSec === null || currentSpeedMetersPerSec === undefined || currentSpeedMetersPerSec === 0)) {
    const timeElapsedSec = (now - lastPosition.timestamp) / 1000;
    if (timeElapsedSec > 0.5) {
      const distanceMeters = calculateDistanceMeters(
        lastPosition.latitude,
        lastPosition.longitude,
        latitude,
        longitude
      );
      currentSpeedMetersPerSec = distanceMeters / timeElapsedSec;
    }
  }

  lastPosition = { latitude, longitude, timestamp: now };

  if (!initialCenterDone) {
    map.setView([latitude, longitude], 16);
    initialCenterDone = true;
  }

  if (!userMarker) {
    userMarker = L.circleMarker([latitude, longitude], {
      radius: 8,
      fillColor: '#3b82f6',
      color: '#ffffff',
      weight: 3,
      opacity: 1,
      fillOpacity: 1
    }).addTo(map);
  } else {
    userMarker.setLatLng([latitude, longitude]);
  }

  // Unlock current H3 Cell
  const currentCell = latLngToCell(latitude, longitude, H3_RESOLUTION);
  if (!unlockedCells.has(currentCell)) {
    unlockedCells.add(currentCell);
    saveHexes(unlockedCells);
  }

  updateUIStats(currentSpeedMetersPerSec);
  fogEngine.render(Array.from(unlockedCells));
}

// Update DOM elements
function updateUIStats(speedMetersPerSec) {
  const countDisplay = document.getElementById('unlockedCount');
  const speedDisplay = document.getElementById('speedDisplay');

  if (countDisplay) {
    countDisplay.textContent = unlockedCells.size;
  }

  if (speedDisplay) {
    const kmh = speedMetersPerSec ? Math.max(0, Math.round(speedMetersPerSec * 3.6)) : 0;
    speedDisplay.textContent = `${kmh} km/h`;
  }
}

// --- 3. Request Location & GPS Watchers ---
async function startGPS() {
  if ('geolocation' in navigator) {
    navigator.geolocation.getCurrentPosition(
      (pos) => onLocationUpdate(pos),
      (err) => console.warn('Web initial location prompt warning:', err),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  try {
    await BackgroundGeolocation.addWatcher(
      {
        backgroundMessage: "Tracking your explored areas in background...",
        backgroundTitle: "Fog of War Active",
        requestPermissions: true,
        stale: false,
        distanceFilter: 3
      },
      (location, error) => {
        if (error) return;
        if (location && isTrackingActive) {
          onLocationUpdate({
            coords: {
              latitude: location.latitude,
              longitude: location.longitude,
              speed: location.speed
            },
            timestamp: location.time || Date.now()
          });
        }
      }
    );
  } catch (err) {
    navigator.geolocation.watchPosition(
      (pos) => {
        if (isTrackingActive) onLocationUpdate(pos);
      },
      (err) => console.warn('Watch GPS Error:', err),
      { enableHighAccuracy: true }
    );
  }
}

// --- 4. Controls ---
document.getElementById('btnCenter')?.addEventListener('click', () => {
  if (userMarker) {
    map.setView(userMarker.getLatLng(), 16);
  }
});

document.getElementById('btnToggleTracking')?.addEventListener('click', (e) => {
  isTrackingActive = !isTrackingActive;
  const btn = e.currentTarget;
  btn.classList.toggle('btn-active', isTrackingActive);
  btn.innerHTML = isTrackingActive ? '📡 GPS On' : '📡 GPS Off';
});

// --- 5. Export & Import Feature ---
document.getElementById('btnExport')?.addEventListener('click', () => {
  if (unlockedCells.size === 0) {
    alert('No unlocked areas to export yet!');
    return;
  }

  const exportData = {
    app: 'fog-of-war',
    exportedAt: new Date().toISOString(),
    hexes: Array.from(unlockedCells)
  };

  const jsonString = JSON.stringify(exportData, null, 2);
  const blob = new Blob([jsonString], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `fog_of_war_backup_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

const fileInput = document.getElementById('fileInput');

document.getElementById('btnImport')?.addEventListener('click', () => {
  fileInput?.click();
});

fileInput?.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();

  reader.onload = (event) => {
    try {
      let rawText = event.target?.result;

      if (!rawText || typeof rawText !== 'string') {
        throw new Error('File is empty or unreadable.');
      }

      // Strip UTF-8 Byte Order Mark (BOM) if present
      if (rawText.charCodeAt(0) === 0xFEFF) {
        rawText = rawText.slice(1);
      }
      rawText = rawText.trim();

      // Step 1: Safe JSON Parse
      const parsed = JSON.parse(rawText);

      // Step 2: Signature Validation
      if (!parsed || parsed.app !== 'fog-of-war' || !Array.isArray(parsed.hexes)) {
        alert('Invalid or incompatible Fog of War backup file.');
        return;
      }

      // Step 3: Non-empty Check
      if (parsed.hexes.length === 0) {
        alert('The backup file contains no hex data.');
        return;
      }

      // Step 4: Max Count Check
      if (parsed.hexes.length > MAX_IMPORT_HEXES) {
        alert(`File contains too many hexes (${parsed.hexes.length}). Maximum allowed is ${MAX_IMPORT_HEXES}.`);
        return;
      }

      // Step 5: Sanitize & Validate H3 Strings
      const validHexes = [];
      for (let item of parsed.hexes) {
        if (typeof item === 'string') {
          const cleanHex = item.trim().toLowerCase();
          if (isValidCell(cleanHex)) {
            validHexes.push(cleanHex);
          }
        }
      }

      if (validHexes.length === 0) {
        alert('No valid H3 hexagon IDs found in the file.');
        return;
      }

      // Step 6: Load into App & Re-render
      unlockedCells = new Set(validHexes);
      saveHexes(unlockedCells);
      updateUIStats(0);
      fogEngine.render(Array.from(unlockedCells));

      alert(`Successfully imported ${validHexes.length} unlocked hexes!`);
    } catch (err) {
      console.error('Import failure:', err);
      alert('Failed to import file. Please ensure it is a valid JSON backup file.');
    } finally {
      // Reset input so re-selecting the same file works again
      e.target.value = '';
    }
  };

  reader.readAsText(file);
});

startGPS();