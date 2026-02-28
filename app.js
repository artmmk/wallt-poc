import * as THREE from 'https://unpkg.com/three@0.162.0/build/three.module.js';
import { ARButton } from 'https://unpkg.com/three@0.162.0/examples/jsm/webxr/ARButton.js';

const APP_VERSION = '0.4.0';
const statusEl = document.getElementById('status');
const diagSummaryEl = document.getElementById('diagSummary');
const diagDetailsEl = document.getElementById('diagDetails');
const toggleDiagBtn = document.getElementById('toggleDiagBtn');
const appVersionEl = document.getElementById('appVersion');
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
let surfacePatch;
let surfaceFrame;
let paintingRoot;
let hitTestSource = null;
let hitTestSourceRequested = false;
let placementLocked = false;
let lastHitResult = null;
let activeAnchor = null;
let anchorRequestId = 0;
let hasSmoothedReticlePose = false;
let hasLockedPlacementPose = false;
let surfaceDetected = false;
let placementMode = 'none';
let frameCounter = 0;
let hitFrameCounter = 0;
let lastDiagUpdateAt = 0;
let diagExpanded = false;
let surfaceStability = 'unknown';
let surfaceStabilityScore = 0;
let hasPreviousRawPose = false;

const IMAGE_WIDTH = 960;
const IMAGE_HEIGHT = 1452;
const IMAGE_ASPECT = IMAGE_WIDTH / IMAGE_HEIGHT;
const BASE_HEIGHT_METERS = 0.65;
const MANUAL_PLACE_DISTANCE_METERS = 1.2;
const RETICLE_SMOOTHING = 0.22;
const ANCHOR_POSITION_SMOOTHING = 0.18;
const SURFACE_PATCH_SIZE_METERS = 0.34;
const DIAG_UPDATE_MS = 180;
const STABILITY_POSITION_REF_METERS = 0.008;
const STABILITY_ANGLE_REF_RAD = 0.09;

const tempMatrix = new THREE.Matrix4();
const tempScale = new THREE.Vector3(1, 1, 1);
const smoothedReticlePosition = new THREE.Vector3();
const smoothedReticleQuaternion = new THREE.Quaternion();
const rawReticlePosition = new THREE.Vector3();
const rawReticleQuaternion = new THREE.Quaternion();
const previousRawReticlePosition = new THREE.Vector3();
const previousRawReticleQuaternion = new THREE.Quaternion();
const anchoredPosition = new THREE.Vector3();
const anchoredQuaternion = new THREE.Quaternion();
const lockedPlacementPosition = new THREE.Vector3();
const lockedPlacementQuaternion = new THREE.Quaternion();
const colorRed = new THREE.Color(0xff5f57);
const colorYellow = new THREE.Color(0xffc24d);
const colorGreen = new THREE.Color(0x17e6a1);

init();
animate();

function init() {
  appVersionEl.textContent = `v${APP_VERSION}`;

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

  ({ patch: surfacePatch, frame: surfaceFrame } = createSurfaceHighlight());
  scene.add(surfacePatch);
  scene.add(surfaceFrame);

  paintingRoot = createPaintingMesh();
  paintingRoot.visible = false;
  scene.add(paintingRoot);
  applyScaleFromUi();
  updateDiagnostics();

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
    hasLockedPlacementPose = false;
    placementMode = 'none';
    surfaceDetected = false;
    surfaceStability = 'unknown';
    surfaceStabilityScore = 0;
    hasPreviousRawPose = false;
    placementLocked = false;
    paintingRoot.visible = false;
    surfacePatch.visible = false;
    surfaceFrame.visible = false;
  });

  renderer.xr.addEventListener('sessionend', () => {
    statusEl.textContent = 'AR-сессия завершена. Можно запустить снова.';
    clearActiveAnchor();
    lastHitResult = null;
    hasSmoothedReticlePose = false;
    hasLockedPlacementPose = false;
    placementMode = 'none';
    surfaceDetected = false;
    surfaceStability = 'unknown';
    surfaceStabilityScore = 0;
    hasPreviousRawPose = false;
    hitTestSourceRequested = false;
    hitTestSource = null;
    surfacePatch.visible = false;
    surfaceFrame.visible = false;
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
    hasLockedPlacementPose = false;
    placementMode = 'none';
    surfaceDetected = false;
    surfaceStability = 'unknown';
    surfaceStabilityScore = 0;
    hasPreviousRawPose = false;
    placementLocked = false;
    paintingRoot.visible = false;
    surfacePatch.visible = false;
    surfaceFrame.visible = false;
    statusEl.textContent = 'Наведите на стену и тапните для новой позиции.';
  });

  togglePanelBtn.addEventListener('click', () => {
    const collapsed = infoPanel.classList.toggle('is-collapsed');
    panelBody.hidden = collapsed;
    togglePanelBtn.textContent = collapsed ? 'Развернуть' : 'Свернуть';
    togglePanelBtn.setAttribute('aria-expanded', String(!collapsed));
  });

  toggleDiagBtn.addEventListener('click', () => {
    diagExpanded = !diagExpanded;
    diagDetailsEl.hidden = !diagExpanded;
    toggleDiagBtn.textContent = diagExpanded ? 'Скрыть diag' : 'Показать diag';
  });

  scaleRange.addEventListener('input', () => {
    applyScaleFromUi();
  });

  window.addEventListener('resize', onWindowResize);
}

function placePaintingFromReticle() {
  placementMode = 'surface-hit';
  paintingRoot.visible = true;
  paintingRoot.matrix.fromArray(reticle.matrix.elements);
  paintingRoot.matrix.decompose(paintingRoot.position, paintingRoot.quaternion, paintingRoot.scale);
  lockedPlacementPosition.copy(paintingRoot.position);
  lockedPlacementQuaternion.copy(paintingRoot.quaternion);
  hasLockedPlacementPose = true;
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
  placementMode = 'manual-fallback';

  paintingRoot.visible = true;
  paintingRoot.matrix.compose(placementPosition, cameraQuaternion, placementScale);
  paintingRoot.position.copy(placementPosition);
  paintingRoot.quaternion.copy(cameraQuaternion);
  paintingRoot.scale.copy(placementScale);
  lockedPlacementPosition.copy(placementPosition);
  lockedPlacementQuaternion.copy(cameraQuaternion);
  hasLockedPlacementPose = true;
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
    placementMode = 'surface-no-anchor';
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
    placementMode = 'anchor';
    statusEl.textContent = 'Картина закреплена по anchor. Стабильность улучшена.';
  }).catch(() => {
    placementMode = 'surface-no-anchor';
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

function createSurfaceHighlight() {
  const patchGeometry = new THREE.PlaneGeometry(SURFACE_PATCH_SIZE_METERS, SURFACE_PATCH_SIZE_METERS);
  const patchMaterial = new THREE.MeshBasicMaterial({
    color: 0x17e6a1,
    transparent: true,
    opacity: 0.22,
    side: THREE.DoubleSide,
    depthWrite: false
  });
  const patch = new THREE.Mesh(patchGeometry, patchMaterial);
  patch.matrixAutoUpdate = false;
  patch.visible = false;

  const edges = new THREE.EdgesGeometry(patchGeometry);
  const frameMaterial = new THREE.LineBasicMaterial({
    color: 0x90ffd8,
    transparent: true,
    opacity: 0.95,
    depthWrite: false
  });
  const frame = new THREE.LineSegments(edges, frameMaterial);
  frame.matrixAutoUpdate = false;
  frame.visible = false;

  return { patch, frame };
}

function updateDiagnostics(now = performance.now()) {
  if (!diagSummaryEl || !diagDetailsEl) {
    return;
  }

  if (now - lastDiagUpdateAt < DIAG_UPDATE_MS) {
    return;
  }
  lastDiagUpdateAt = now;

  const sessionActive = Boolean(renderer?.xr?.getSession());
  const hitSourceState = hitTestSource ? 'ready' : (hitTestSourceRequested ? 'requesting' : 'off');
  const anchorState = activeAnchor ? 'active' : 'none';
  const placementState = placementLocked ? 'locked' : 'free';
  const surfaceState = surfaceDetected ? 'found' : 'none';
  const stabilityState = surfaceStability;

  diagSummaryEl.textContent = `diag: session=${sessionActive ? 'on' : 'off'} | surface=${surfaceState}(${stabilityState}) | anchor=${anchorState}`;
  diagDetailsEl.textContent = [
    `version: ${APP_VERSION}`,
    `placement: ${placementState} (${placementMode})`,
    `hit-source: ${hitSourceState}`,
    `stability-score: ${surfaceStabilityScore.toFixed(2)}`,
    `reticle: ${reticle?.visible ? 'visible' : 'hidden'}`,
    `surface-patch: ${surfacePatch?.visible ? 'visible' : 'hidden'}`,
    `frames: ${frameCounter}, hit-frames: ${hitFrameCounter}`
  ].join('\n');
}

function updateSurfaceStability() {
  if (!hasPreviousRawPose) {
    previousRawReticlePosition.copy(rawReticlePosition);
    previousRawReticleQuaternion.copy(rawReticleQuaternion);
    hasPreviousRawPose = true;
    surfaceStabilityScore = 1;
    surfaceStability = 'good';
    return;
  }

  const positionDelta = rawReticlePosition.distanceTo(previousRawReticlePosition);
  const angleDelta = rawReticleQuaternion.angleTo(previousRawReticleQuaternion);
  previousRawReticlePosition.copy(rawReticlePosition);
  previousRawReticleQuaternion.copy(rawReticleQuaternion);

  const normalizedPosition = Math.min(positionDelta / STABILITY_POSITION_REF_METERS, 1.8);
  const normalizedAngle = Math.min(angleDelta / STABILITY_ANGLE_REF_RAD, 1.8);
  const instantScore = Math.max(0, 1 - (0.62 * normalizedPosition + 0.38 * normalizedAngle));

  surfaceStabilityScore = THREE.MathUtils.lerp(surfaceStabilityScore, instantScore, 0.22);

  if (surfaceStabilityScore >= 0.68) {
    surfaceStability = 'good';
  } else if (surfaceStabilityScore >= 0.42) {
    surfaceStability = 'medium';
  } else {
    surfaceStability = 'poor';
  }
}

function applySurfaceDebugColor() {
  let targetColor = colorYellow;
  if (surfaceStability === 'good') {
    targetColor = colorGreen;
  } else if (surfaceStability === 'poor') {
    targetColor = colorRed;
  }

  surfacePatch.material.color.copy(targetColor);
  surfaceFrame.material.color.copy(targetColor);
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
  frameCounter += 1;
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
          surfaceDetected = true;
          hitFrameCounter += 1;
          tempMatrix.fromArray(pose.transform.matrix);
          tempMatrix.decompose(rawReticlePosition, rawReticleQuaternion, tempScale);
          updateSurfaceStability();

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
          surfacePatch.visible = true;
          applySurfaceDebugColor();
          surfacePatch.matrix.copy(tempMatrix);
          surfaceFrame.visible = true;
          applySurfaceDebugColor();
          surfaceFrame.matrix.copy(tempMatrix);
          if (surfaceStability === 'good') {
            statusEl.textContent = 'Поверхность стабильна (green). Можно размещать.';
          } else if (surfaceStability === 'medium') {
            statusEl.textContent = 'Поверхность средняя (yellow). Можно подождать лучшей стабилизации.';
          } else {
            statusEl.textContent = 'Поверхность шумная (red). Подвигайте камеру и улучшите свет.';
          }
        }
      } else {
        reticle.visible = false;
        surfacePatch.visible = false;
        surfaceFrame.visible = false;
        lastHitResult = null;
        surfaceDetected = false;
        surfaceStability = 'unknown';
        surfaceStabilityScore = 0;
        hasPreviousRawPose = false;
        hasSmoothedReticlePose = false;
        statusEl.textContent = 'Ищу поверхность. Можно тапнуть, чтобы поставить картину перед камерой.';
      }
    } else if (placementLocked) {
      reticle.visible = false;
      surfacePatch.visible = false;
      surfaceFrame.visible = false;
      if (activeAnchor) {
        const anchorPose = frame.getPose(activeAnchor.anchorSpace, referenceSpace);
        if (anchorPose && hasLockedPlacementPose) {
          const currentScale = Number(scaleRange.value) / 100;
          tempMatrix.fromArray(anchorPose.transform.matrix);
          tempMatrix.decompose(anchoredPosition, anchoredQuaternion, tempScale);
          lockedPlacementPosition.lerp(anchoredPosition, ANCHOR_POSITION_SMOOTHING);
          paintingRoot.matrix.compose(
            lockedPlacementPosition,
            lockedPlacementQuaternion,
            tempScale.set(currentScale, currentScale, currentScale)
          );
          paintingRoot.position.copy(lockedPlacementPosition);
          paintingRoot.quaternion.copy(lockedPlacementQuaternion);
          paintingRoot.scale.set(currentScale, currentScale, currentScale);
        }
      }
    }
  }

  updateDiagnostics();
  renderer.render(scene, camera);
}
