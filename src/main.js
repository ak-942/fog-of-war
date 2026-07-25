import { registerPlugin } from '@capacitor/core';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { latLngToCell } from 'h3-js';
import { FogEngine } from './fogEngine.js'; 

const BackgroundGeolocation = registerPlugin('BackgroundGeolocation');

// --- Configuration Constants ---
// Resolution 10 = ~130m across (Resolution 11 = ~50m across)
const H3_RESOLUTION = 12; 
const STORAGE_KEY = 'fog_unlocked_cells';

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
let unlockedCells = loadSavedHexes(); // Loaded from disk on launch
let userMarker = null;
let initialCenterDone = false;
let isTrackingActive = true;

// Track last position for custom speed calculation fallback
let lastPosition = null;

// Initial UI & Fog Render from stored memory
updateUIStats(0);
fogEngine.render(Array.from(unlockedCells));

map.on('move', () => {
  fogEngine.render(Array.from(unlockedCells));
});

// --- Distance Calculation (Haversine Formula in meters) ---
function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth radius in meters
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

  // Calculate speed fallback if native speed is null/zero
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

  // Save current position as last position
  lastPosition = { latitude, longitude, timestamp: now };

  // Center map on user for initial fix
  if (!initialCenterDone) {
    map.setView([latitude, longitude], 16);
    initialCenterDone = true;
  }

  // Update or create location marker
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

  // Unlock smaller H3 Cell (Resolution 10)
  const currentCell = latLngToCell(latitude, longitude, H3_RESOLUTION);
  if (!unlockedCells.has(currentCell)) {
    unlockedCells.add(currentCell);
    saveHexes(unlockedCells); // Save immediately to disk
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
  e.currentTarget.classList.toggle('btn-active', isTrackingActive);
});

document.getElementById('btnClear')?.addEventListener('click', () => {
  if (confirm('Are you sure you want to clear your unlocked fog progress?')) {
    unlockedCells.clear();
    localStorage.removeItem(STORAGE_KEY);
    updateUIStats(0);
    fogEngine.render([]);
  }
});

startGPS();