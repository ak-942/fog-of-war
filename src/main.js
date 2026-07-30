import { registerPlugin } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { latLngToCell, isValidCell, gridPathCells, gridDistance, gridDisk } from 'h3-js';
import { FogEngine } from './fogEngine.js';

const BackgroundGeolocation = registerPlugin('BackgroundGeolocation');

// --- Configuration Constants ---
const H3_RESOLUTION = 11; 
const STORAGE_KEY = 'fog_unlocked_cells';
const MAX_IMPORT_HEXES = 200000;

// Safety Guardrail Thresholds
const MAX_ACCURACY_METERS = 35;
const MIN_JITTER_DISTANCE_M = 3;
const MAX_CHAIN_DISTANCE_M = 300;
const MAX_GRID_STEPS = 40;

// --- LocalStorage Helpers ---
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

// --- Map & Fog Engine Setup ---
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
let lastValidCell = null;
let speedHistory = [];

// Initial Render
updateUIStats(0);
fogEngine.render(Array.from(unlockedCells));

map.on('move', () => {
  fogEngine.render(Array.from(unlockedCells));
});

// --- Distance Calculation (Haversine Formula) ---
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

// --- Auto-Hole Filling (Fills Trapped "Donut" Hexes) ---
function fillTrappedHoles(newlyUnlocked, unlockedSet) {
  let queue = Array.from(newlyUnlocked);

  while (queue.length > 0) {
    const nextQueue = [];
    for (const cell of queue) {
      const kRing = gridDisk(cell, 1);
      for (const neighbor of kRing) {
        if (!unlockedSet.has(neighbor)) {
          const neighborRing = gridDisk(neighbor, 1).filter(c => c !== neighbor);
          let unlockedCount = 0;
          for (const n of neighborRing) {
            if (unlockedSet.has(n)) unlockedCount++;
          }
          if (unlockedCount >= 5) {
            unlockedSet.add(neighbor);
            nextQueue.push(neighbor);
          }
        }
      }
    }
    queue = nextQueue;
  }
}

// --- Location Update Handler ---
function onLocationUpdate(position) {
  const { latitude, longitude, accuracy, speed } = position.coords;
  const now = position.timestamp || Date.now();

  if (accuracy && accuracy > MAX_ACCURACY_METERS) {
    console.warn(`GPS fix rejected: accuracy (${Math.round(accuracy)}m) exceeds ${MAX_ACCURACY_METERS}m limit.`);
    return;
  }

  let distanceMoved = 0;
  let rawSpeedMetersPerSec = 0;

  if (lastPosition) {
    const timeElapsedSec = (now - lastPosition.timestamp) / 1000;
    distanceMoved = calculateDistanceMeters(
      lastPosition.latitude,
      lastPosition.longitude,
      latitude,
      longitude
    );

    if (distanceMoved < MIN_JITTER_DISTANCE_M) {
      rawSpeedMetersPerSec = 0;
    } else if (timeElapsedSec > 0.5) {
      rawSpeedMetersPerSec = distanceMoved / timeElapsedSec;
    } else {
      rawSpeedMetersPerSec = speed || 0;
    }
  } else if (speed !== null && speed !== undefined) {
    rawSpeedMetersPerSec = speed;
  }

  lastPosition = { latitude, longitude, timestamp: now };

  speedHistory.push(rawSpeedMetersPerSec);
  if (speedHistory.length > 3) speedHistory.shift();
  const smoothedSpeed = speedHistory.reduce((a, b) => a + b, 0) / speedHistory.length;

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

  const currentCell = latLngToCell(latitude, longitude, H3_RESOLUTION);
  const newlyUnlocked = new Set();

  if (lastValidCell && lastValidCell !== currentCell) {
    const canChain = 
      distanceMoved <= MAX_CHAIN_DISTANCE_M && 
      gridDistance(lastValidCell, currentCell) <= MAX_GRID_STEPS;

    if (canChain) {
      try {
        const chainedHexes = gridPathCells(lastValidCell, currentCell);
        for (const hex of chainedHexes) {
          if (!unlockedCells.has(hex)) {
            unlockedCells.add(hex);
            newlyUnlocked.add(hex);
          }
        }
      } catch (err) {
        console.warn('Grid path calculation failed, unlocking current cell only:', err);
        if (!unlockedCells.has(currentCell)) {
          unlockedCells.add(currentCell);
          newlyUnlocked.add(currentCell);
        }
      }
    } else {
      if (!unlockedCells.has(currentCell)) {
        unlockedCells.add(currentCell);
        newlyUnlocked.add(currentCell);
      }
    }
  } else {
    if (!unlockedCells.has(currentCell)) {
      unlockedCells.add(currentCell);
      newlyUnlocked.add(currentCell);
    }
  }

  lastValidCell = currentCell;

  if (newlyUnlocked.size > 0) {
    fillTrappedHoles(newlyUnlocked, unlockedCells);
    saveHexes(unlockedCells);
  }

  updateUIStats(smoothedSpeed);
  fogEngine.render(Array.from(unlockedCells));
}

function updateUIStats(speedMetersPerSec) {
  const countDisplay = document.getElementById('unlockedCount');
  const speedDisplay = document.getElementById('speedDisplay');

  if (countDisplay) countDisplay.textContent = unlockedCells.size;
  if (speedDisplay) {
    const kmh = speedMetersPerSec ? Math.max(0, Math.round(speedMetersPerSec * 3.6)) : 0;
    speedDisplay.textContent = `${kmh} km/h`;
  }
}

// --- GPS Watcher ---
async function startGPS() {
  if ('geolocation' in navigator) {
    navigator.geolocation.getCurrentPosition(
      (pos) => onLocationUpdate(pos),
      (err) => console.warn('Web initial location warning:', err),
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
              accuracy: location.accuracy,
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

// --- Sidebar Menu Logic ---
const btnMenu = document.getElementById('btnMenu');
const btnCloseSidebar = document.getElementById('btnCloseSidebar');
const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebarOverlay');

function openSidebar() {
  sidebar?.classList.add('open');
  sidebarOverlay?.classList.add('active');
}

function closeSidebar() {
  sidebar?.classList.remove('open');
  sidebarOverlay?.classList.remove('active');
}

btnMenu?.addEventListener('click', openSidebar);
btnCloseSidebar?.addEventListener('click', closeSidebar);
sidebarOverlay?.addEventListener('click', closeSidebar);

// --- Controls ---
document.getElementById('btnCenter')?.addEventListener('click', () => {
  if (userMarker) {
    map.setView(userMarker.getLatLng(), 16);
  } else {
    alert('Waiting for GPS position...');
  }
});

document.getElementById('btnToggleTracking')?.addEventListener('click', (e) => {
  isTrackingActive = !isTrackingActive;
  const btn = e.currentTarget;
  btn.classList.toggle('btn-active', isTrackingActive);
  btn.innerHTML = isTrackingActive ? '📡 GPS On' : '📡 GPS Off';
});

// --- Export Function (Native Filesystem + Web Fallback) ---
document.getElementById('btnExport')?.addEventListener('click', async () => {
  closeSidebar();
  if (unlockedCells.size === 0) {
    alert('No unlocked areas to export yet!');
    return;
  }

  const fileName = `fog_of_war_backup_${new Date().toISOString().slice(0, 10)}.json`;
  const exportData = {
    app: 'fog-of-war',
    exportedAt: new Date().toISOString(),
    hexes: Array.from(unlockedCells)
  };
  const jsonString = JSON.stringify(exportData, null, 2);

  try {
    // Save natively into device's Documents directory via Capacitor Filesystem
    await Filesystem.writeFile({
      path: fileName,
      data: jsonString,
      directory: Directory.Documents,
      encoding: Encoding.UTF8
    });
    alert(`Export successful!\n\nSaved to: Documents/${fileName}`);
  } catch (nativeErr) {
    console.warn('Native filesystem write failed, trying web download fallback:', nativeErr);
    
    // Fallback for Web Browser
    try {
      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      alert('Export successful!');
    } catch (webErr) {
      console.error('Export error:', webErr);
      alert(`Export failed: ${webErr.message || 'Unable to save backup file.'}`);
    }
  }
});

// --- Import Function ---
const fileInput = document.getElementById('fileInput');

document.getElementById('btnImport')?.addEventListener('click', () => {
  closeSidebar();
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

      if (rawText.charCodeAt(0) === 0xFEFF) {
        rawText = rawText.slice(1);
      }
      rawText = rawText.trim();

      const parsed = JSON.parse(rawText);

      if (!parsed || parsed.app !== 'fog-of-war' || !Array.isArray(parsed.hexes)) {
        alert('Invalid or incompatible Fog of War backup file.');
        return;
      }

      if (parsed.hexes.length === 0) {
        alert('The backup file contains no hex data.');
        return;
      }

      if (parsed.hexes.length > MAX_IMPORT_HEXES) {
        alert(`File contains too many hexes (${parsed.hexes.length}). Maximum allowed is ${MAX_IMPORT_HEXES}.`);
        return;
      }

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

      unlockedCells = new Set(validHexes);
      saveHexes(unlockedCells);
      updateUIStats(0);
      fogEngine.render(Array.from(unlockedCells));

      alert(`Successfully imported ${validHexes.length} unlocked hexes!`);
    } catch (err) {
      console.error('Import failure:', err);
      alert('Failed to import file. Please ensure it is a valid JSON backup file.');
    } finally {
      e.target.value = '';
    }
  };

  reader.readAsText(file);
});

startGPS();