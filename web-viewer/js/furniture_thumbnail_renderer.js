import * as THREE from 'three';

export class Isometric3DThumbnailRenderer {
  constructor(load) {
    this.load = load;
    this.renderer = null;
    this.queue = Promise.resolve();
    this.cache = new Map();
    this.observer = new IntersectionObserver(entries => {
      for (const { target, isIntersecting } of entries) {
        if (!isIntersecting) continue;
        this.observer.unobserve(target);
        this.draw(target, target.dataset.glb);
      }
    }, { rootMargin: '160px' });
  }

  watch(canvas, url) {
    canvas.dataset.glb = url;
    this.observer.observe(canvas);
  }

  draw(canvas, url) {
    if (!this.cache.has(url)) {
      const image = this.queue.then(async () => {
        if (!this.renderer) this.init();
        const model = (await this.load(url)).scene;
        this.scene.add(model);
        try {
          const box = new THREE.Box3();
          model.traverse(mesh => {
            if (mesh.isMesh && !mesh.userData.isContactShadow && mesh.name !== 'ContactShadowPlane') box.expandByObject(mesh, true);
          });
          const sphere = box.getBoundingSphere(new THREE.Sphere());
          if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) throw new Error('Empty model');
          this.camera.position.copy(sphere.center).addScaledVector(this.direction, sphere.radius * 4);
          this.camera.lookAt(sphere.center);
          this.camera.updateMatrixWorld();
          // Fit the projected box in a square while retaining the model's XYZ proportions.
          const half = sphere.radius * 1.4;
          let horizontal = 0, vertical = 0;
          for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
            const point = new THREE.Vector3(x,y,z).applyMatrix4(this.camera.matrixWorldInverse);
            horizontal = Math.max(horizontal, Math.abs(point.x));
            vertical = Math.max(vertical, Math.abs(point.y));
          }
          const fit = (Math.max(horizontal,vertical) || half) / 0.78;
          this.camera.left = this.camera.bottom = -fit;
          this.camera.right = this.camera.top = fit;
          this.camera.far = sphere.radius * 10;
          this.camera.updateProjectionMatrix();
          this.renderer.render(this.scene, this.camera);
          const image = document.createElement('canvas');
          image.width = image.height = 512;
          image.getContext('2d').drawImage(this.renderer.domElement, 0, 0);
          return image;
        } finally {
          model.removeFromParent();
          const textures = new Set();
          model.traverse(mesh => {
            mesh.geometry?.dispose();
            for (const material of [mesh.material].flat().filter(Boolean)) {
              for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
              material.dispose();
            }
          });
          for (const texture of textures) texture.dispose();
        }
      });
      this.cache.set(url, image);
      this.queue = image.catch(() => {});
    }
    this.cache.get(url).then(image => {
      if (!canvas.isConnected) return;
      canvas.getContext('2d').drawImage(image, 0, 0);
      canvas.dataset.rendered = 'true';
    }).catch(() => {
      this.cache.delete(url);
      if (canvas.isConnected) {
        canvas.hidden = true;
        canvas.nextElementSibling.hidden = false;
      }
    });
  }

  init() {
    this.renderer = new THREE.WebGLRenderer({ antialias:true, preserveDrawingBuffer:true });
    this.renderer.setSize(512,512,false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#F3F1EC');
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb9aa97, 1.5));
    for (const [color, intensity, position] of [
      [0xffe2ca,3,[4,7,5]], [0xdbe9ff,1.35,[-4,3,2]], [0xffffff,2,[0,5,-5]]
    ]) {
      const light = new THREE.DirectionalLight(color,intensity);
      light.position.set(...position);
      this.scene.add(light);
    }
    this.camera = new THREE.OrthographicCamera(-1,1,1,-1,0.0001,100);
    this.direction = new THREE.Vector3(1,0.78,1).normalize();
  }
}
