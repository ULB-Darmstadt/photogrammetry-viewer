import '@google/model-viewer';
import {ModelViewerElement} from '@google/model-viewer';
import {customElement, property} from 'lit/decorators.js';
import {
  Camera,
  Vector3,
  Raycaster,
  Matrix3,
  Matrix4,
  Sprite,
  Color,
  CanvasTexture,
  SpriteMaterial,
  ArrowHelper,
} from 'three';
import {SingleClickEventHandler, debounce} from './helper';

import {css} from 'lit';

import {
  $scene,
  $userInputElement,
} from '@google/model-viewer/lib/model-viewer-base';
import {
  $controls,
  SphericalPosition,
} from '@google/model-viewer/lib/features/controls';
import {ChangeSource} from '@google/model-viewer/lib/three-components/SmoothControls';
import {ViewerSettings} from './viewer-settings';
import {EulerYXZ} from './eulerYXZ';
import {MeasurementTool} from './measurement-tool';
import {radToDeg} from './angle-math-utils';

function getSpriteMaterial(color: Color, text: string | null = null) {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;

  const context = canvas.getContext('2d');

  if (context == null) {
    return;
  }
  context.beginPath();
  context.arc(32, 32, 16, 0, 2 * Math.PI);
  context.closePath();
  context.fillStyle = color.getStyle();
  context.fill();

  if (text !== null) {
    const textSize = 20;
    context.font = textSize + 'px Arial';

    const textMetrics = context.measureText(text);
    const textWidth = textMetrics.width;
    const textHeight =
      textMetrics.actualBoundingBoxAscent -
      textMetrics.actualBoundingBoxDescent;
    const x = (canvas.width - textWidth) / 2;
    const y = (canvas.height + textHeight) / 2;

    context.fillStyle = '#ffffff';
    context.fillText(text, x, y);
  }

  const texture = new CanvasTexture(canvas);
  return new SpriteMaterial({map: texture, toneMapped: false});
}

@customElement('viewer-3d')
export class ViewerElement3D extends ModelViewerElement {
  private _coordinateAxes: ArrowHelper[] = [];
  private _coordinateLabel: Sprite[] = [];

  private _lastSphericalPosition: SphericalPosition = {
    theta: -1,
    phi: -1,
    radius: -1,
  };
  private _lastFieldOfViewInDeg: number = -1;

  private _referenceFieldOfViewInRad: number = -1;
  private _referenceMaxRadius: number = -1;
  private _isRadiusConst: boolean = false;
  private _maxZoomLevel: number = 100; // default value //identical to image zoom
  private _minZoomLevel: number = 0.5; // default value
  private _currentZoomLevel: number = 1.0;

  private _minPhiInDeg: number = 0;
  private _maxPhiInDeg: number = 1800;

  private _deltaX: number = 0;
  private _deltaY: number = 0;

  @property({type: Object})
  measurementTool!: MeasurementTool;

  constructor() {
    super();

    this.addEventListener('load', this._handleModelLoaded);
    this.addEventListener('camera-change', this._handleCameraChanged);
    this.orientation = '0deg -90deg 0deg'

    const singleClickEventHandler = new SingleClickEventHandler(this);
    singleClickEventHandler.on(
        'single-click',
        this._handleSceneClicked.bind(this),
    );
    this.addEventListener(
        'pointerup',
        () => (this[$userInputElement].style.cursor = 'default'),
    );
    this.addEventListener(
        'pointerdown',
        () => (this[$userInputElement].style.cursor = 'pointer'),
    );
    singleClickEventHandler.on('pointerevent-is-hold-event', () => {
      console.log('Single click over'),
      (this[$userInputElement].style.cursor = 'grabbing');
    });
  }

  firstUpdated() {
    this[$scene].add(this.measurementTool.sceneElementGroup);
    this.measurementTool.on('scene-update-requested', () =>
      this.updateRendering(),
    );
    this.measurementTool.on(
        'calculate-hotspot-requested',
        this._intersectObject.bind(this),
    );
    this.measurementTool.on(
        'hotspot-added',
        this._handleHotspotAdded.bind(this),
    );
  }

  connectWithSettings(viewerSettings: ViewerSettings): void {
    viewerSettings.modelOrientation.on(
        'model-orientation-changed',
        (eulerOrientation: EulerYXZ) => {
          this.orientation = eulerOrientation.angleInRadAsString();
          this.measurementTool.eulerOrientation = eulerOrientation;
        },
    );

    viewerSettings.environment3D.on(
        'change-axes-visibility-requested',
        this._changeAxesVisibility.bind(this),
    );
    viewerSettings.environment3D.on(
        'change-viewer-background-color-requested',
        this._changeBackgroundColor.bind(this),
    );
    viewerSettings.environment3D.on(
        'change-exposure-requested',
        (brightness: number) => (this.exposure = brightness),
    );

    const [currentBackgroundColor, currentGradientColor] =
      viewerSettings.environment3D.backgroundColor;
    this._changeBackgroundColor(currentBackgroundColor, currentGradientColor);
  }

  resize(height: number, width: number): void {
    this.style.height = height + 'px';
    this.style.width = width + 'px';

    this[$scene].idealAspect = this[$scene].aspect; // if the format is not "ideal", model-viewer changes the fov values
  }

  getCamera(): Camera {
    return this[$scene].camera;
  }

  setReferenceFieldOfView(
      fovInRad: number,
      updateViewer: boolean = false,
  ): void {
    if (fovInRad == this._referenceFieldOfViewInRad) {
      if (updateViewer) {
        this.fieldOfView = fovInRad + 'rad';
      }

      return;
    }

    this._referenceFieldOfViewInRad = fovInRad;
    this[$scene].idealAspect = this[$scene].aspect;
    this.minFieldOfView = fovInRad / this._maxZoomLevel + 'rad';
    this.maxFieldOfView = fovInRad / this._minZoomLevel + 'rad';

    if (updateViewer) {
      this.fieldOfView = fovInRad + 'rad';
    }

    // update maxRadius:
    const viewerDim = this.getDimensions();
    const maxLength = Math.sqrt(
        viewerDim.x * viewerDim.x +
        viewerDim.y * viewerDim.y +
        viewerDim.z * viewerDim.z,
    );

    if (this.clientWidth > this.clientHeight) {
      this._referenceMaxRadius = maxLength / fovInRad;
    } else {
      this._referenceMaxRadius =
        ((maxLength / fovInRad) * this.clientHeight) / this.clientWidth;
    }

    if (!this._isRadiusConst) {
      this.maxCameraOrbit =
        'Infinity ' +
        this._maxPhiInDeg +
        'deg ' +
        this._referenceMaxRadius +
        'm';
    }
  }

  rotateModel(dx: number, dy: number): void {
    const conversionFactor = (2 * Math.PI) / this[$scene].height;
    const deltaTheta = conversionFactor * dx;
    const deltaPhi = conversionFactor * dy;

    const controls = (this as any)[$controls];
    controls.changeSource = ChangeSource.USER_INTERACTION;
    controls.adjustOrbit(deltaTheta, deltaPhi, 0);
  }

  zoomTo(zoomLevel: number): void {
    if (this._referenceFieldOfViewInRad == -1) {
      console.log('Return 3d  zoom, ', this._currentZoomLevel);
      return;
    }

    this._currentZoomLevel = zoomLevel;
    this[$scene].idealAspect = this[$scene].aspect; // ensure that the idealAspect is equal to aspect
    this.fieldOfView = this._referenceFieldOfViewInRad / zoomLevel + 'rad';
  }

  setViewerOffset(deltaX: number, deltaY: number) {
    if (this._deltaX != deltaX || this._deltaY != deltaY) {
      this._deltaX = deltaX;
      this._deltaY = deltaY;

      this[$scene].camera.setViewOffset(
          this.clientWidth,
          this.clientHeight,
          deltaX,
          deltaY,
          this.clientWidth,
          this.clientHeight,
      );
      this.updateRendering();
    }
  }

  updateRendering() {
    this[$scene].queueRender();
  }

  setMinZoomLevel(minZoomLevel: number): void {
    if (this._minZoomLevel == minZoomLevel) {
      return;
    }
    if (this._referenceFieldOfViewInRad != -1) {
      const updatedMaxFov = this._referenceFieldOfViewInRad / minZoomLevel;
      const currentFov = (this.getFieldOfView() / 180) * Math.PI;
      if (updatedMaxFov < currentFov) {
        if (this._isRadiusConst == false) {
          const currentOrbitPos = this.getCameraOrbit();
          const currentRadius = this.getCameraOrbit().radius;
          currentOrbitPos.radius = (currentRadius * currentFov) / updatedMaxFov;
          this.cameraOrbit = currentOrbitPos.toString();
        } else {
          this.fieldOfView = updatedMaxFov + 'rad';
        }
      }

      this.maxFieldOfView = updatedMaxFov + 'rad';
      this._minZoomLevel = minZoomLevel;
    }
  }

  setCameraOrbitPos(orbitPos: SphericalPosition): void {
    if (this._isRadiusConst) {
      this.minCameraOrbit =
        '-Infinity ' + this._minPhiInDeg + 'deg ' + orbitPos.radius + 'm';
      this.maxCameraOrbit =
        'Infinity ' + this._maxPhiInDeg + 'deg ' + orbitPos.radius + 'm';
    }

    this.cameraOrbit = orbitPos.toString();
  }

  updateRadiusMode(isRadiusConst: boolean): void {
    if (isRadiusConst == this._isRadiusConst) {
      return;
    }

    this._isRadiusConst = isRadiusConst;

    if (isRadiusConst) {
      const currentRadius = this.getCameraOrbit().radius;
      this.minCameraOrbit =
        '-Infinity ' + this._minPhiInDeg + 'deg ' + currentRadius + 'm';
      this.maxCameraOrbit =
        'Infinity ' + this._maxPhiInDeg + 'deg ' + currentRadius + 'm';
    } else {
      this.minCameraOrbit = '-Infinity ' + this._minPhiInDeg + 'deg  auto';

      const maxRadiusString =
        this._referenceMaxRadius > 0 ? this._referenceMaxRadius + 'm' : 'auto';
      this.maxCameraOrbit =
        'Infinity ' + this._maxPhiInDeg + 'deg ' + maxRadiusString;
    }
  }

  private _changeAxesVisibility(showAxes: boolean) {
    this._changeCoordinateVisibility(showAxes);
    this.updateRendering();
  }

  private _changeBackgroundColor(
      backgroundColor: string,
      gradientColor: string,
  ) {
    console.log('Change background color', backgroundColor, gradientColor);
    if (gradientColor) {
      this.style.background =
        'radial-gradient(circle at center, ' +
        gradientColor +
        ', ' +
        backgroundColor +
        ')';
    } else {
      this.style.background = backgroundColor;
    }
  }

  private _handleHotspotAdded(domElement: HTMLButtonElement) {
    domElement.addEventListener('hotspot-position-changed', () => {
      this.updateHotspot({
        name: domElement.slot,
        position: domElement.dataset.position,
        normal: domElement.dataset.normal,
      });
    });

    this.appendChild(domElement);
  }

  private _intersectObject(origin: Vector3, direction: Vector3) {
    const currentCamTargetPos = this.getCameraTarget();
    console.log('Current translation 2', currentCamTargetPos);

    origin.x -= currentCamTargetPos.x;
    origin.y -= currentCamTargetPos.y;
    origin.z -= currentCamTargetPos.z;

    this[$scene].remove(this.measurementTool.sceneElementGroup);
    this._removeCoordinateElements();

    const raycaster = new Raycaster(origin, direction);
    const hits = raycaster.intersectObject(this[$scene], true);

    this[$scene].add(this.measurementTool.sceneElementGroup);
    this._addCoordinateElements();

    const hit = hits.find(
        (hit) => hit.object.visible && !hit.object.userData.shadow,
    );

    if (hit == null || hit.face == null) {
      console.log(
          'Object intersection not found, not adding point from 3D scene.',
      );
      return;
    }

    let position3D;
    let normal3D;
    if (hit.uv == null) {
      position3D = hit.point;
      normal3D = hit.face.normal;
    } else {
      hit.face.normal.applyNormalMatrix(
          new Matrix3().getNormalMatrix(hit.object.matrixWorld),
      );
      position3D = hit.point;
      normal3D = hit.face.normal;
    }

    position3D.x += currentCamTargetPos.x;
    position3D.y += currentCamTargetPos.y;
    position3D.z += currentCamTargetPos.z;

    this.measurementTool.addPointFrom3DScene(position3D, normal3D, false);
  }

  private _coordinateLabelIsClicked(event: MouseEvent): boolean {
    // Check if if coordinate label is clicked if visible:
    if (this._coordinateAxes.length == 0 || !this._coordinateAxes[0].visible) {
      return false;
    }

    const ndcPosition = this[$scene].getNDC(event.clientX, event.clientY);

    const raycaster = new Raycaster();
    raycaster.setFromCamera(ndcPosition, this.getCamera());
    const intersects = raycaster.intersectObjects(this._coordinateLabel, true);
    console.log('Label hit?', intersects.length);
    if (intersects.length == 0) {
      return false;
    }
    const object = intersects[0].object;
    const currentOrbitPos = this.getCameraOrbit();
    switch (object.userData.type) {
      case 'posX':
        currentOrbitPos.phi = 0.5 * Math.PI;
        currentOrbitPos.theta = 0.5 * Math.PI;
        break;

      case 'posY':
        currentOrbitPos.phi = 0;
        currentOrbitPos.theta = 0;
        break;

      case 'posZ':
        currentOrbitPos.phi = 0.5 * Math.PI;
        currentOrbitPos.theta = 0;
        break;

      case 'negX':
        currentOrbitPos.phi = 0.5 * Math.PI;
        currentOrbitPos.theta = 1.5 * Math.PI;
        break;

      case 'negY':
        currentOrbitPos.phi = Math.PI;
        currentOrbitPos.theta = 0;
        break;

      case 'negZ':
        currentOrbitPos.phi = 0.5 * Math.PI;
        currentOrbitPos.theta = Math.PI;
        break;

      default:
        console.log('default');
        break;
    }
    this.cameraOrbit = currentOrbitPos.toString();
    this._emitCamOrbitAngleChanged();
    return true;
  }

  private _handleSceneClicked(event: MouseEvent) {
    console.log('Single Click into scene');

    // First check if coordinate label is clicked
    if (this._coordinateLabelIsClicked(event)) {
      return;
    }

    if (!this.measurementTool.isEditModeActive) {
      return;
    }

    const x = event.clientX;
    const y = event.clientY;

    this[$scene].remove(this.measurementTool.sceneElementGroup);
    this._removeCoordinateElements();

    const positionAndNormal = this.positionAndNormalFromPoint(x, y);

    this[$scene].add(this.measurementTool.sceneElementGroup);
    this._addCoordinateElements();

    if (positionAndNormal == null) {
      console.log('no hit result: mouse = ', x, ', ', y);
      return;
    }

    const {position, normal} = positionAndNormal;

    this.measurementTool.addPointFrom3DScene(position, normal);
  }

  private _addCoordinateElements(): void {
    this._coordinateAxes.forEach((axes) => {
      this[$scene].add(axes);
    });

    this._coordinateLabel.forEach((label) => {
      this[$scene].add(label);
    });
  }

  private _removeCoordinateElements(): void {
    this._coordinateAxes.forEach((axes) => {
      this[$scene].remove(axes);
    });

    this._coordinateLabel.forEach((label) => {
      this[$scene].remove(label);
    });
  }

  private _changeCoordinateVisibility(isVisible: boolean): void {
    this._coordinateAxes.forEach((axes) => {
      axes.visible = isVisible;
    });

    this._coordinateLabel.forEach((label) => {
      label.visible = isVisible;
    });
  }

  private _handleModelLoaded(): void {
    const dim = this.getDimensions();
    const maxDim = Math.max(Math.max(dim.x, dim.y), dim.z);
    const axesLength = maxDim * 0.5;

    this._coordinateAxes.push(
        new ArrowHelper(
            new Vector3(axesLength, 0, 0),
            new Vector3(-axesLength, 0, 0),
            axesLength * 2,
            'red',
            0.5,
            0.25,
        ),
    );
    this._coordinateAxes.push(
        new ArrowHelper(
            new Vector3(0, axesLength, 0),
            new Vector3(0, -axesLength, 0),
            axesLength * 2,
            'green',
            0.5,
            0.25,
        ),
    );
    this._coordinateAxes.push(
        new ArrowHelper(
            new Vector3(0, 0, axesLength),
            new Vector3(0, 0, -axesLength),
            axesLength * 2,
            'blue',
            0.5,
            0.25,
        ),
    );
    this._coordinateAxes.forEach((axis) => {
      axis.visible = false; // default from EnvironmentSettings
    });

    const scalingVec = new Vector3(0.5, 0.5, 0.5);
    const transformMat = new Matrix4();
    transformMat.scale(scalingVec);

    const xAxisLabel = new Sprite(getSpriteMaterial(new Color('red'), 'X'));
    xAxisLabel.userData.type = 'posX';
    xAxisLabel.applyMatrix4(transformMat);
    xAxisLabel.position.x = axesLength;
    this._coordinateLabel.push(xAxisLabel);

    const negXAxisLabel = new Sprite(
        getSpriteMaterial(new Color(1, 0.2, 0.2), '-x'),
    );
    negXAxisLabel.userData.type = 'negX';
    negXAxisLabel.applyMatrix4(transformMat);
    negXAxisLabel.position.x = -axesLength;
    this._coordinateLabel.push(negXAxisLabel);

    const yAxisLabel = new Sprite(getSpriteMaterial(new Color('green'), 'y'));
    yAxisLabel.userData.type = 'posY';
    yAxisLabel.applyMatrix4(transformMat);
    yAxisLabel.position.y = axesLength;
    this._coordinateLabel.push(yAxisLabel);

    const negYAxisLabel = new Sprite(
        getSpriteMaterial(new Color(0.2, 1.0, 0.2), '-y'),
    );
    negYAxisLabel.userData.type = 'negY';
    negYAxisLabel.applyMatrix4(transformMat);
    negYAxisLabel.position.y = -axesLength;
    this._coordinateLabel.push(negYAxisLabel);

    const zAxisLabel = new Sprite(getSpriteMaterial(new Color('blue'), 'z'));
    zAxisLabel.userData.type = 'posZ';
    zAxisLabel.applyMatrix4(transformMat);
    zAxisLabel.position.z = axesLength;
    this._coordinateLabel.push(zAxisLabel);

    const negZAxisLabel = new Sprite(
        getSpriteMaterial(new Color(0.2, 0.2, 1.0), '-z'),
    );
    negZAxisLabel.userData.type = 'negZ';
    negZAxisLabel.applyMatrix4(transformMat);
    negZAxisLabel.position.z = -axesLength;
    this._coordinateLabel.push(negZAxisLabel);

    this._coordinateLabel.forEach((axis) => {
      axis.visible = false; // default from EnvironmentSettings
    });

    this._addCoordinateElements();

    this._lastSphericalPosition = this.getCameraOrbit();

    this[$scene].idealAspect = this[$scene].aspect;
    this[$scene].queueRender();

    this._emitCamOrbitAngleChanged();
    this[$userInputElement].style.cursor = 'default';
    this.minCameraOrbit = '-Infinity ' + this._minPhiInDeg + 'deg  auto';
    this.maxCameraOrbit = 'Infinity ' + this._maxPhiInDeg + 'deg auto';
  }

  private _handleCameraChanged(event: Event): void {
    this.measurementTool.translation = new Vector3().setFromMatrixPosition(
        this[$scene].target.matrixWorld,
    );

    const currentCamPosition = this.getCameraOrbit();
    const currentFovInDeg = this.getFieldOfView();

    if ((event as CustomEvent).detail.source != 'user-interaction') {
      this._lastSphericalPosition = currentCamPosition;
      this._lastFieldOfViewInDeg = currentFovInDeg;
      return;
    }

    // compare just angle and not radius
    if (
      this._lastSphericalPosition.phi != currentCamPosition.phi ||
      this._lastSphericalPosition.theta != currentCamPosition.theta
    ) {
      console.log(
          'CamChanged',
          this.getCameraOrbit(),
          this._lastSphericalPosition,
      ); // just emit if orbit angle changed

      if (currentCamPosition.radius > 0) {
        this._emitCamOrbitAngleChanged();
      }
    }
    if (
      this._lastSphericalPosition.radius == currentCamPosition.radius &&
      this._lastFieldOfViewInDeg != currentFovInDeg
    ) {
      this._currentZoomLevel =
        radToDeg(this._referenceFieldOfViewInRad) / currentFovInDeg;
      console.log(
          'FOV change',
          this._currentZoomLevel,
          radToDeg(this._referenceFieldOfViewInRad),
          currentFovInDeg,
      );

      this.dispatchEvent(
          new CustomEvent('fov-based-zoom-changed', {
            detail: {
              zoomLevel: this._currentZoomLevel,
            },
          }),
      );
    }

    this._lastSphericalPosition = currentCamPosition;
    this._lastFieldOfViewInDeg = currentFovInDeg;
  }

  private _emitCamOrbitAngleChanged: () => void = debounce(() => {
    console.log(
        'Cam Phi Theta',
        radToDeg(this._lastSphericalPosition.phi),
        radToDeg(this._lastSphericalPosition.theta),
    );
    this.dispatchEvent(new Event('cam-orbit-angle-changed'));
  }, 250);

  static styles = css``;
}
