import { cellToBoundary } from 'h3-js';

export class FogEngine {
  constructor(canvas, map) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.map = map;
    this.lastUnlockedCells = [];
    
    this.resizeCanvas();
    window.addEventListener('resize', () => this.resizeCanvas());
  }

  resizeCanvas() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    if (this.lastUnlockedCells.length > 0) {
      this.render(this.lastUnlockedCells);
    }
  }

  render(unlockedCells = []) {
    this.lastUnlockedCells = unlockedCells;
    const { width, height } = this.canvas;
    
    // 1. Clear current frame
    this.ctx.clearRect(0, 0, width, height);

    // 2. Draw semi-transparent dark fog layer (0.70 opacity)
    this.ctx.fillStyle = 'rgba(15, 23, 42, 0.70)';
    this.ctx.fillRect(0, 0, width, height);

    // 3. Set blend mode to erase fog
    this.ctx.globalCompositeOperation = 'destination-out';

    // 4. Draw actual H3 Hexagon Polygons for all unlocked cells
    unlockedCells.forEach((cellId) => {
      try {
        // cellToBoundary returns array of [lat, lng] vertices for the hexagon
        const boundary = cellToBoundary(cellId); 
        if (!boundary || boundary.length === 0) return;

        this.ctx.beginPath();
        boundary.forEach(([lat, lng], index) => {
          // Convert each GPS vertex to screen pixel coordinates
          const point = this.map.latLngToContainerPoint([lat, lng]);
          if (index === 0) {
            this.ctx.moveTo(point.x, point.y);
          } else {
            this.ctx.lineTo(point.x, point.y);
          }
        });
        this.ctx.closePath();
        this.ctx.fill();
      } catch (e) {
        console.error('Error drawing H3 cell:', cellId, e);
      }
    });

    // Reset blend mode back to normal
    this.ctx.globalCompositeOperation = 'source-over';
  }
}