import * as THREE from 'https://unpkg.com/three@0.162.0/build/three.module.js';
import { ARButton } from 'https://unpkg.com/three@0.162.0/examples/jsm/webxr/ARButton.js';

const statusEl = document.getElementById('status');
const infoPanel = document.getElementById('infoPanel');
const panelBody = document.getElementById('panelBody');
const togglePanelBtn = document.getElementById('togglePanelBtn');
const scaleRange = document.getElementById('scaleRange');
const scaleValue = document.getElementById('scaleValue');
const placeNowBtn = document.getElementById('placeNowBtn');
const placeAgainBtn = document.getElementById('placeAgainBtn');

let camera;
let scene;
let renderer;
let reticle;
let paintingRoot;
let hitTestSource = null;
let hitTestSourceRequested = false;
let placementLocked = false;
let lastHitResult = null;
let activeAnchor = null;
let anchorRequestId = 0;
let hasSmoothedReticlePose = false;

const IMAGE_WIDTH = 960;
const IMAGE_HEIGHT = 1452;
const IMAGE_ASPECT = IMAGE_WIDTH / IMAGE_HEIGHT;
const BASE_HEIGHT_METERS = 0.65;
const MANUAL_PLACE_DISTANCE_METERS = 1.2;
const RETICLE_SMOOTHING = 0.22;

const tempMatrix = new THREE.Matrix4();
const tempScale = new THREE.Vector3(1, 1, 1);
const smoothedReticlePosition = new THREE.Vector3();
const smoothedReticleQuaternion = new THREE.Quaternion();
const rawReticlePosition = new THREE.Vector3();
const rawReticleQuaternion = new THREE.Quaternion();
const anchoredPosition = new THREE.Vector3();
const anchoredQuaternion = new THREE.Quaternion();

init();
animate();

function init() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  document.body.appendChild(renderer.domElement);

  const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1.3);
  scene.add(light);

  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.06, 0.085, 32),
    new THREE.MeshBasicMaterial({ color: 0x33d1a0 })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  paintingRoot = createPaintingMesh();
  paintingRoot.visible = false;
  scene.add(paintingRoot);
  applyScaleFromUi();

  if ('xr' in navigator) {
    navigator.xr.isSessionSupported('immersive-ar').then((supported) => {
      if (!supported) {
        statusEl.textContent = 'Этот браузер не поддерживает WebXR AR.';
        return;
      }

      const button = ARButton.createButton(renderer, {
        requiredFeatures: ['hit-test'],
        optionalFeatures: ['dom-overlay', 'anchors'],
        domOverlay: { root: document.body }
      });
      button.style.zIndex = '6';
      button.style.bottom = '18px';
      button.style.left = '16px';
      button.style.right = '16px';
      button.style.width = 'auto';
      button.style.borderRadius = '12px';
      document.body.appendChild(button);

      statusEl.textContent = 'Нажмите «Start AR». Если поверхность не найдется, тап поставит картину перед камерой.';
    });
  } else {
    statusEl.textContent = 'WebXR API недоступен в этом браузере.';
  }

  renderer.xr.addEventListener('sessionstart', () => {
    statusEl.textContent = 'Сканирую поверхности. Медленно ведите камерой по стене.';
    clearActiveAnchor();
    lastHitResult = null;
    hasSmoothedReticlePose = false;
    placementLocked = false;
    paintingRoot.visible = false;
  });

  renderer.xr.addEventListener('sessionend', () => {
    statusEl.textContent = 'AR-сессия завершена. Можно запустить снова.';
    clearActiveAnchor();
    lastHitResult = null;
    hasSmoothedReticlePose = false;
    hitTestSourceRequested = false;
    hitTestSource = null;
  });

  renderer.xr.addEventListener('select', () => {
    placePaintingNow();
  });

  placeNowBtn.addEventListener('click', () => {
    const session = renderer.xr.getSession();
    if (!session) {
      statusEl.textContent = 'Сначала нажмите Start AR.';
      return;
    }
    placePaintingNow();
  });

  placeAgainBtn.addEventListener('click', () => {
    clearActiveAnchor();
    lastHitResult = null;
    placementLocked = false;
    paintingRoot.visible = false;
    statusEl.textContent = 'Наведите на стену и тапните для новой позиции.';
  });

  togglePanelBtn.addEventListener('click', () => {
    const collapsed = infoPanel.classList.toggle('is-collapsed');
    panelBody.hidden = collapsed;
    togglePanelBtn.textContent = collapsed ? 'Развернуть' : 'Свернуть';
    togglePanelBtn.setAttribute('aria-expanded', String(!collapsed));
  });

  scaleRange.addEventListener('input', () => {
    applyScaleFromUi();
  });

  window.addEventListener('resize', onWindowResize);
}

function placePaintingFromReticle() {
  paintingRoot.visible = true;
  paintingRoot.matrix.fromArray(reticle.matrix.elements);
  paintingRoot.matrix.decompose(paintingRoot.position, paintingRoot.quaternion, paintingRoot.scale);
  applyScaleFromUi();
  tryCreateAnchorFromHitResult();
}

function placePaintingInFrontOfCamera() {
  const cameraPosition = new THREE.Vector3();
  const cameraQuaternion = new THREE.Quaternion();
  const cameraForward = new THREE.Vector3();
  const targetScale = Number(scaleRange.value) / 100;

  camera.getWorldPosition(cameraPosition);
  camera.getWorldQuaternion(cameraQuaternion);
  camera.getWorldDirection(cameraForward);

  const placementPosition = cameraPosition.add(cameraForward.multiplyScalar(MANUAL_PLACE_DISTANCE_METERS));
  const placementScale = new THREE.Vector3(targetScale, targetScale, targetScale);

  paintingRoot.visible = true;
  paintingRoot.matrix.compose(placementPosition, cameraQuaternion, placementScale);
  paintingRoot.position.copy(placementPosition);
  paintingRoot.quaternion.copy(cameraQuaternion);
  paintingRoot.scale.copy(placementScale);
}

function placePaintingNow() {
  if (reticle.visible) {
    placePaintingFromReticle();
    placementLocked = true;
    statusEl.textContent = 'Картина закреплена. Выполняю стабилизацию положения.';
    return;
  }

  placePaintingInFrontOfCamera();
  placementLocked = true;
  statusEl.textContent = 'Поверхность не найдена. Картина поставлена перед камерой.';
}

function tryCreateAnchorFromHitResult() {
  if (!lastHitResult || typeof lastHitResult.createAnchor !== 'function') {
    statusEl.textContent = 'Картина закреплена без anchor. Возможна легкая дрожь.';
    return;
  }

  const requestId = ++anchorRequestId;
  lastHitResult.createAnchor().then((anchor) => {
    if (requestId !== anchorRequestId || !anchor) {
      if (anchor && typeof anchor.delete === 'function') {
        anchor.delete();
      }
      return;
    }

    clearActiveAnchor();
    activeAnchor = anchor;
    statusEl.textContent = 'Картина закреплена по anchor. Стабильность улучшена.';
  }).catch(() => {
    statusEl.textContent = 'Anchor недоступен. Картина закреплена статически.';
  });
}

function clearActiveAnchor() {
  anchorRequestId += 1;
  if (activeAnchor && typeof activeAnchor.delete === 'function') {
    activeAnchor.delete();
  }
  activeAnchor = null;
}

function createPaintingMesh() {
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;

  const texture = new THREE.TextureLoader().load('./Mona_Lisa.jpg');
  texture.colorSpace = THREE.SRGBColorSpace;

  const height = BASE_HEIGHT_METERS;
  const width = height * IMAGE_ASPECT;

  const pictureGeometry = new THREE.PlaneGeometry(width, height);
  const pictureMaterial = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
  const picture = new THREE.Mesh(pictureGeometry, pictureMaterial);
  picture.position.z = 0.001;
  group.add(picture);

  const frameGeometry = new THREE.PlaneGeometry(width + 0.04, height + 0.04);
  const frameMaterial = new THREE.MeshStandardMaterial({ color: 0x4b3318, roughness: 0.65, metalness: 0.1 });
  const frame = new THREE.Mesh(frameGeometry, frameMaterial);
  group.add(frame);

  return group;
}

function applyScaleFromUi() {
  const scale = Number(scaleRange.value) / 100;
  scaleValue.textContent = `${scaleRange.value}%`;

  if (!paintingRoot) {
    return;
  }

  const previousMatrix = paintingRoot.matrix.clone();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const originalScale = new THREE.Vector3();
  previousMatrix.decompose(position, quaternion, originalScale);

  const targetScale = new THREE.Vector3(scale, scale, scale);
  paintingRoot.matrix.compose(position, quaternion, targetScale);
  paintingRoot.position.copy(position);
  paintingRoot.quaternion.copy(quaternion);
  paintingRoot.scale.copy(targetScale);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
  renderer.setAnimationLoop(render);
}

function render(_, frame) {
  const session = renderer.xr.getSession();

  if (frame && session) {
    const referenceSpace = renderer.xr.getReferenceSpace();

    if (!hitTestSourceRequested) {
      session.requestReferenceSpace('viewer').then((viewerSpace) => {
        session.requestHitTestSource({ space: viewerSpace }).then((source) => {
          hitTestSource = source;
        });
      });

      session.addEventListener('end', () => {
        hitTestSourceRequested = false;
        hitTestSource = null;
      });

      hitTestSourceRequested = true;
    }

    if (hitTestSource && !placementLocked) {
      const hitTestResults = frame.getHitTestResults(hitTestSource);
      if (hitTestResults.length > 0) {
        const hit = hitTestResults[0];
        const pose = hit.getPose(referenceSpace);
        lastHitResult = hit;

        if (pose) {
          tempMatrix.fromArray(pose.transform.matrix);
          tempMatrix.decompose(rawReticlePosition, rawReticleQuaternion, tempScale);

          if (!hasSmoothedReticlePose) {
            smoothedReticlePosition.copy(rawReticlePosition);
            smoothedReticleQuaternion.copy(rawReticleQuaternion);
            hasSmoothedReticlePose = true;
          } else {
            smoothedReticlePosition.lerp(rawReticlePosition, RETICLE_SMOOTHING);
            smoothedReticleQuaternion.slerp(rawReticleQuaternion, RETICLE_SMOOTHING);
          }

          tempMatrix.compose(smoothedReticlePosition, smoothedReticleQuaternion, tempScale.set(1, 1, 1));
          reticle.visible = true;
          reticle.matrix.copy(tempMatrix);
          statusEl.textContent = 'Поверхность найдена. Разместите картину.';
        }
      } else {
        reticle.visible = false;
        lastHitResult = null;
        hasSmoothedReticlePose = false;
        statusEl.textContent = 'Ищу поверхность. Можно тапнуть, чтобы поставить картину перед камерой.';
      }
    } else if (placementLocked) {
      reticle.visible = false;
      if (activeAnchor) {
        const anchorPose = frame.getPose(activeAnchor.anchorSpace, referenceSpace);
        if (anchorPose) {
          const currentScale = Number(scaleRange.value) / 100;
          tempMatrix.fromArray(anchorPose.transform.matrix);
          tempMatrix.decompose(anchoredPosition, anchoredQuaternion, tempScale);
          paintingRoot.matrix.compose(
            anchoredPosition,
            anchoredQuaternion,
            tempScale.set(currentScale, currentScale, currentScale)
          );
          paintingRoot.position.copy(anchoredPosition);
          paintingRoot.quaternion.copy(anchoredQuaternion);
          paintingRoot.scale.set(currentScale, currentScale, currentScale);
        }
      }
    }
  }

  renderer.render(scene, camera);
}
