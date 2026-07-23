import { cellToLatLng } from 'h3-js';

export class FogEngine {
  constructor(canvas, map) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.map = map;
    this.resizeCanvas();
    window.addEventListener('resize', () => this.resizeCanvas());
  }

  resizeCanvas() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  render(unlockedCells) {
    const { width, height } = this.canvas;
    
    // 1. Clear frame
    this.ctx.clearRect(0, 0, width, height);

    // 2. Semi-transparent dark fog (0.65 opacity)
    this.ctx.fillStyle = 'rgba(15, 23, 42, 0.55)';
    this.ctx.fillRect(0, 0, width, height);

    // 3. Set blend mode to erase fog
    this.ctx.globalCompositeOperation = 'destination-out';

    // 4. Convert cell IDs to center lat/lng and draw smooth overlapping circles
    unlockedCells.forEach((cellId) => {
      const [lat, lng] = cellToLatLng(cellId);
      const screenPoint = this.map.latLngToContainerPoint([lat, lng]);
      
      // ~32-meter radius circle per H3 cell creates seamless overlapping circles
      const pixelRadius = this.getMetersToPixels(lat, 32);

      this.ctx.beginPath();
      this.ctx.arc(screenPoint.x, screenPoint.y, pixelRadius, 0, Math.PI * 2);
      this.ctx.fill();
    });

    // Reset blend mode
    this.ctx.globalCompositeOperation = 'source-over';
  }

  getMetersToPixels(lat, meters) {
    const p1 = this.map.latLngToContainerPoint([lat, 0]);
    const p2 = this.map.latLngToContainerPoint([lat + (meters / 111111), 0]);
    return Math.max(Math.abs(p1.y - p2.y), 4);
  }
}