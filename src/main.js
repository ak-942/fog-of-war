import { registerPlugin } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { latLngToCell, isValidCell, gridPathCells, gridDistance, gridDisk } from 'h3-js';
import { FogEngine } from './fogEngine.js';
import { initGoogleDrive, backupToDrive, restoreFromDrive, checkWeeklyAutoBackup } from './driveBackup.js';

const BackgroundGeolocation = registerPlugin('BackgroundGeolocation');

// --- Configuration Constants ---
const H3_RESOLUTION = 11; 
const H3_RES11_AREA_SQ_METERS = 2250;
const STORAGE_KEY = 'fog_unlocked_cells';
const TRIP_DISTANCE_KEY = 'fog_trip_distance_meters';
const LIFETIME_DISTANCE_KEY = 'fog_lifetime_distance_meters';
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

function loadSavedTripDistance() {
  try {
    const saved = localStorage.getItem(TRIP_DISTANCE_KEY);
    return saved ? parseFloat(saved) : 0;
  } catch (e) {
    return 0;
  }
}

function saveTripDistance(meters) {
  try {
    localStorage.setItem(TRIP_DISTANCE_KEY, meters.toString());
  } catch (e) {
    console.error('Failed to save trip distance:', e);
  }
}

function loadSavedLifetimeDistance() {
  try {
    const saved = localStorage.getItem(LIFETIME_DISTANCE_KEY);
    if (saved) return parseFloat(saved);

    const legacySaved = localStorage.getItem('fog_total_distance_meters');
    return legacySaved ? parseFloat(legacySaved) : 0;
  } catch (e) {
    return 0;
  }
}

function saveLifetimeDistance(meters) {
  try {
    localStorage.setItem(LIFETIME_DISTANCE_KEY, meters.toString());
  } catch (e) {
    console.error('Failed to save lifetime distance:', e);
  }
}

// App State
let unlockedCells = loadSavedHexes();
let tripDistanceMeters = loadSavedTripDistance();
let lifetimeDistanceMeters = loadSavedLifetimeDistance();
let userMarker = null;
let initialCenterDone = false;
let isTrackingActive = true;
let lastPosition = null;
let lastValidCell = null;
let speedHistory = [];
let map, fogEngine;

// --- Distance Calculation ---
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

// --- Formatting Helpers ---
function formatArea(hexCount) {
  const totalAreaM2 = hexCount * H3_RES11_AREA_SQ_METERS;
  if (totalAreaM2 >= 10000) {
    return `${(totalAreaM2 / 1000000).toFixed(2)} km²`;
  }
  return `${Math.round(totalAreaM2).toLocaleString()} m²`;
}

function formatDistance(meters) {
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(2)} km`;
  }
  return `${Math.round(meters)} m`;
}

function updateUIStats(speedMetersPerSec) {
  const areaDisplay = document.getElementById('areaDisplay');
  const distanceDisplay = document.getElementById('distanceDisplay');
  const speedDisplay = document.getElementById('speedDisplay');
  const lifetimeDisplay = document.getElementById('lifetimeDistanceDisplay');
  const hexCountDisplay = document.getElementById('hexCountDisplay');

  if (areaDisplay) areaDisplay.textContent = formatArea(unlockedCells.size);
  if (distanceDisplay) distanceDisplay.textContent = formatDistance(tripDistanceMeters);
  if (lifetimeDisplay) lifetimeDisplay.textContent = formatDistance(lifetimeDistanceMeters);
  if (hexCountDisplay) hexCountDisplay.textContent = unlockedCells.size.toLocaleString();
  if (speedDisplay) {
    const kmh = speedMetersPerSec ? Math.max(0, Math.round(speedMetersPerSec * 3.6)) : 0;
    speedDisplay.textContent = `${kmh} km/h`;
  }
}

// --- Auto-Hole Filling ---
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
    } else {
      tripDistanceMeters += distanceMoved;
      lifetimeDistanceMeters += distanceMoved;

      saveTripDistance(tripDistanceMeters);
      saveLifetimeDistance(lifetimeDistanceMeters);

      if (timeElapsedSec > 0.5) {
        rawSpeedMetersPerSec = distanceMoved / timeElapsedSec;
      } else {
        rawSpeedMetersPerSec = speed || 0;
      }
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
        backgroundTitle: "Explore Active",
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

function getAppDataPayload() {
  return {
    app: 'fog-of-war',
    exportedAt: new Date().toISOString(),
    tripDistanceMeters: tripDistanceMeters,
    lifetimeDistanceMeters: lifetimeDistanceMeters,
    hexes: Array.from(unlockedCells)
  };
}

function updateBackupStatusDisplay() {
  const lastBackup = localStorage.getItem('explore_last_drive_backup');
  const displayEl = document.getElementById('lastBackupTimeDisplay');
  if (displayEl) {
    displayEl.textContent = lastBackup ? new Date(lastBackup).toLocaleDateString() : 'Never';
  }
}

// --- DOM & Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
  map = L.map('map').setView([22.7196, 75.8577], 16);

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap'
  }).addTo(map);

  const canvas = document.getElementById('fog-canvas');
  fogEngine = new FogEngine(canvas, map);

  updateUIStats(0);
  fogEngine.render(Array.from(unlockedCells));

  map.on('move', () => {
    fogEngine.render(Array.from(unlockedCells));
  });

  // Sidebar Controls
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

  document.getElementById('btnResetTrip')?.addEventListener('click', () => {
    if (tripDistanceMeters === 0) {
      alert('Trip distance is already 0 m.');
      return;
    }
    if (confirm('Reset current trip distance to 0? (Overall distance will be kept)')) {
      tripDistanceMeters = 0;
      saveTripDistance(0);
      updateUIStats(0);
      closeSidebar();
    }
  });

  // Export
  document.getElementById('btnExport')?.addEventListener('click', async () => {
    closeSidebar();
    if (unlockedCells.size === 0 && lifetimeDistanceMeters === 0) {
      alert('No explored areas or distance to export yet!');
      return;
    }

    const fileName = `explore_backup_${new Date().toISOString().slice(0, 10)}.json`;
    const exportData = getAppDataPayload();
    const jsonString = JSON.stringify(exportData, null, 2);

    try {
      await Filesystem.writeFile({
        path: `Download/${fileName}`,
        directory: Directory.ExternalStorage,
        data: jsonString,
        encoding: Encoding.UTF8
      });
      alert(`Export successful!\n\nSaved to: Downloads/${fileName}`);
    } catch (nativeErr) {
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
        alert(`Export failed: ${webErr.message || 'Unable to save backup file.'}`);
      }
    }
  });

  // Import
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
        if (!rawText || typeof rawText !== 'string') throw new Error('File empty');
        if (rawText.charCodeAt(0) === 0xFEFF) rawText = rawText.slice(1);
        
        const parsed = JSON.parse(rawText.trim());

        if (!parsed || parsed.app !== 'fog-of-war' || !Array.isArray(parsed.hexes)) {
          alert('Invalid or incompatible Explore backup file.');
          return;
        }

        if (parsed.hexes.length === 0) {
          alert('The backup file contains no hex data.');
          return;
        }

        if (parsed.hexes.length > MAX_IMPORT_HEXES) {
          alert(`File contains too many hexes (${parsed.hexes.length}). Limit is ${MAX_IMPORT_HEXES}.`);
          return;
        }

        const validHexes = parsed.hexes
          .filter(item => typeof item === 'string' && isValidCell(item.trim().toLowerCase()))
          .map(item => item.trim().toLowerCase());

        if (validHexes.length === 0) {
          alert('No valid H3 hexagon IDs found in the file.');
          return;
        }

        unlockedCells = new Set(validHexes);
        saveHexes(unlockedCells);

        if (typeof parsed.tripDistanceMeters === 'number' && !isNaN(parsed.tripDistanceMeters)) {
          tripDistanceMeters = parsed.tripDistanceMeters;
          saveTripDistance(tripDistanceMeters);
        }

        if (typeof parsed.lifetimeDistanceMeters === 'number' && !isNaN(parsed.lifetimeDistanceMeters)) {
          lifetimeDistanceMeters = parsed.lifetimeDistanceMeters;
          saveLifetimeDistance(lifetimeDistanceMeters);
        }

        updateUIStats(0);
        fogEngine.render(Array.from(unlockedCells));
        alert(`Successfully imported ${validHexes.length} unlocked hexes!`);
      } catch (err) {
        alert('Failed to import file. Ensure it is a valid JSON backup file.');
      } finally {
        e.target.value = '';
      }
    };
    reader.readAsText(file);
  });

  // Cloud Backup Initialization
  await initGoogleDrive();
  updateBackupStatusDisplay();
  checkWeeklyAutoBackup(getAppDataPayload);

  document.getElementById('btnDriveBackup')?.addEventListener('click', async () => {
    const btn = document.getElementById('btnDriveBackup');
    try {
      if (btn) { btn.disabled = true; btn.textContent = '⏳ Backing up...'; }
      await backupToDrive(getAppDataPayload());
      updateBackupStatusDisplay();
      alert('Backup successfully saved to Google Drive!');
    } catch (err) {
      alert('Backup failed: ' + err.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '☁️ Backup Now'; }
    }
  });

  document.getElementById('btnDriveRestore')?.addEventListener('click', async () => {
    if (!confirm('Restoring will replace current progress with the cloud backup. Continue?')) return;
    try {
      const data = await restoreFromDrive();
      if (data && Array.isArray(data.hexes)) {
        unlockedCells = new Set(data.hexes);
        lifetimeDistanceMeters = data.lifetimeDistanceMeters || 0;
        tripDistanceMeters = data.tripDistanceMeters || 0;

        saveHexes(unlockedCells);
        saveLifetimeDistance(lifetimeDistanceMeters);
        saveTripDistance(tripDistanceMeters);

        fogEngine.render(Array.from(unlockedCells));
        updateUIStats(0);
        alert('Data successfully restored!');
      }
    } catch (err) {
      alert('Restore failed: ' + err.message);
    }
  });

  startGPS();
});