import {LitElement, css, html} from 'lit';
import {customElement, property, query} from 'lit/decorators.js';

import './viewer-3d';
import {ViewerElement3D} from './viewer-3d';

import './viewer-2d';
import {ViewerElement2D} from './viewer-2d';

import './control-panel';
import {ControlPanel} from './control-panel';

import {ScanInformation} from './scan-information';
import {ImageCamera} from './image-camera';
import {Settings3DViewer, Settings2DViewer} from './sync-settings';
import {
  EnvironmentSettings,
  ImageRotationSettings,
  ModelOrientationSettings,
  ViewerSettings,
} from './viewer-settings';
import {EulerYXZ} from './eulerYXZ';
import {MeasurementTool} from './measurement-tool';
import {
  DefaultPhotogrammetryViewerSettings,
  PhotogrammetryViewerSettings,
} from './public-settings';
import {Vector3} from 'three';

@customElement('photogrammetry-viewer')
export class PhotogrammetryViewer extends LitElement {
  // src file names:
  @property()
  src3D: string = ''; // 'http://localhost:8000/3D/Yup.gltf';

  @property()
  src2D: string = ''; // 'http://localhost:8000/edof/';

  @property()
  srcScanInformation: string = ''; // 'http://localhost:8000/Leptinotarsa_decemlineata_NOKI_metashape_cameras.xml';

  @property()
  loadMeasurement: string | undefined

  // additional configuration
  @property({type: Object})
  viewSettings!: PhotogrammetryViewerSettings;

  // Components:
  @query('#viewerBase')
  viewerBase!: HTMLDivElement;

  @query('#viewer3D')
  viewer3DElement!: ViewerElement3D;

  @query('#viewer2D')
  viewer2DElement!: ViewerElement2D;

  @query('#controls')
  controlsElement!: ControlPanel;

  // additional private classes:
  private _scanInformation: ScanInformation = new ScanInformation();
  private _imageCamera: ImageCamera = new ImageCamera();

  private _syncSettings2DViewer: Settings2DViewer | null = null;
  private _syncSettings3DViewer: Settings3DViewer | null = null;
  private _viewerAspectRatio: number = 1;

  private _viewerSettings: ViewerSettings;

  private _viewModeIndex: number = 2;

  private _isInit: boolean = false;

  private _isColumnDir: boolean = false;

  private _viewerUpdateToken: number = 0;

  private _resizeObserver: ResizeObserver;

  constructor() {
    super();

    this._viewerSettings = {
      imageRotation: new ImageRotationSettings(),
      modelOrientation: new ModelOrientationSettings(),
      measurementTool: new MeasurementTool(),
      environment3D: new EnvironmentSettings(),
      viewer2DElement: null,
      viewer3DElement: null
    };

    this._viewerSettings.modelOrientation.on(
        'model-orientation-changed',
        (newOrientation: EulerYXZ) =>
          this._imageCamera.setAdditionalRotation(newOrientation),
    );
    this._viewerSettings.environment3D.on(
        'change-axes-mapping-requested',
        (newAxes: Vector3) => {
          console.log('Setting new axes mapping');
          this._imageCamera.setAxesRemapping(newAxes);
        },
    );

    this._scanInformation.on(
        'scanInformationExtracted',
        this._handleScanInformationExtracted.bind(this),
    );
    this._imageCamera.on(
        'camera-parameters-changed',
        this._updateViewer.bind(this),
    );
    this._resizeObserver = new ResizeObserver(
        this._handleViewerResizeEvent.bind(this),
    );

    if (this.viewSettings == null) {
      this.viewSettings = new DefaultPhotogrammetryViewerSettings(
          this.src2D,
          '.png',
      );
    }
  }

  render() {
    return html`
      <div id="viewerBase">
        <viewer-3d
          id="viewer3D"
          src=${this.src3D}
          camera-controls
          disable-tap
          camera-orbit="0deg 90deg auto"
          max-camera-orbit="Infinity 157.5deg auto"
          min-camera-orbit="-Infinity 22.5deg auto"
          camera-target="0m 0m 0m"
          exposure="1.2"
          shadow-intensity="0"
          min-field-of-view="0deg"
          max-field-of-view="18deg"
          interaction-prompt="none"
          skybox-image="${this.viewSettings.skyBoxImage}"
          .measurementTool="${this._viewerSettings.measurementTool}"
          @fov-based-zoom-changed="${this._handleFovBasedZoomChanged}"
          @cam-orbit-angle-changed="${this._updateViewer}"
          @dblclick="${this._updateOneViewSyncMode}"
        >
        </viewer-3d>
        <viewer-2d
          id="viewer2D"
          src2D=${this.src2D}
          .measurementTool="${this._viewerSettings.measurementTool}"
          .viewSettings="${this.viewSettings}"
          @image-zoom-changed="${this._handleImageZoomChanged}"
          @image-shifted="${this._handleImageShifted}"
          @min-zoom-level-changed="${this._handleImageMinZoomLevelChanged}"
          @double-press="${this._updateOneViewSyncMode}"
          @pointer-move-in-disable-mode="${this
      ._handlePointerMoveOnImageInDisableMode}"
          @double-press-completed="${this._updateOneViewSyncMode}"
        >
        </viewer-2d>
        <control-panel
          id="controls"
          ?isColumnMode=${this._isColumnDir}
          .viewerSettings="${this._viewerSettings}"
          @view-mode-changed="${this._handleViewModeChanged}"
        >
        </control-panel>
      </div>
    `;
  }

  connectedCallback() {
    super.connectedCallback();
  }

  disconnectedCallback() {
    this._resizeObserver.disconnect();
    super.disconnectedCallback();
  }

  firstUpdated() {
    this._resizeObserver.observe(this.viewerBase);
    this._updateViewerSize();
    requestAnimationFrame(() => this._updateViewerSize());
    this.viewer2DElement.connectWithSettings(this._viewerSettings);
    this.viewer3DElement.connectWithSettings(this._viewerSettings);
    this._viewerSettings.viewer2DElement = this.viewer2DElement;
    this._viewerSettings.viewer3DElement = this.viewer3DElement;
    if (this.loadMeasurement !== undefined) {
      const measurementUrl = this.src3D.split('/').slice(0, -1).join('/') + '/measurement.json'
      this._viewerSettings.measurementTool.loadMeasurement(measurementUrl)
    }
  }

  updated(changedProperties: Map<string, unknown>) {
    super.updated(changedProperties);

    if (changedProperties.has('srcScanInformation')) {
      this._isInit = false;
      this._scanInformation.readFromFile(this.srcScanInformation).then(() => {
        if (!this._scanInformation.isValid) {
          alert('Invalid scan information file');
        }
      });
    }

    if (
      changedProperties.has('src2D') &&
      this.viewSettings instanceof DefaultPhotogrammetryViewerSettings
    ) {
      this.viewSettings = new DefaultPhotogrammetryViewerSettings(
          this.src2D,
          '.png',
      );
    }
  }

  private _handleViewModeChanged(event: CustomEvent) {
    if (this._viewModeIndex == event.detail.viewIndex) {
      return;
    }

    const oldIdx = this._viewModeIndex;
    this._viewModeIndex = event.detail.viewIndex;

    if (oldIdx == 0) {
      // if old mode was one view sync -> seperate 2d and 3d viewer
      this._activateAndShow2DViewer();
      this._updateViewerSize();
    }

    if (oldIdx == 2 || this._viewModeIndex == 2) {
      // if old or new mode is navigation  mode -> change sync behaviour
      this._changeSyncMode();
    }

    if (this._viewModeIndex == 0) {
      // if new mode is one view mode -> change viewer size
      this._updateViewerSize();
    }
  }

  private _handlePointerMoveOnImageInDisableMode(event: CustomEvent) {
    if (this._viewModeIndex > 0) {
      // no one view sync mode
      return;
    }

    this.viewer3DElement.rotateModel(event.detail.dx, event.detail.dy);
  }

  private _handleScanInformationExtracted(): void {
    this._imageCamera.init(
        this._scanInformation,
        this._viewerSettings.modelOrientation.eulerOrientationYXZInRad.angleInRad,
    );
    this.viewer2DElement.setImageFiles(this._scanInformation.imageFiles);

    if (this.viewer3DElement.loaded) {
      this._updateViewer();
    }
  }

  private _activateAndShow2DViewer() {
    this.viewer2DElement.style.cursor = 'auto';
    this.viewer2DElement.style.opacity = '1';
    this.viewer2DElement.style.zIndex = '2';
    this.viewer2DElement.updatePointerEventsState(false);
  }

  private _deactivateAndHide2DViewer() {
    this.viewer2DElement.style.opacity = '0';
    this.viewer2DElement.style.zIndex = '0';
    this.viewer2DElement.updatePointerEventsState(true);
    this.viewer2DElement.style.cursor = 'grabbing';
  }

  private _updateOneViewSyncMode() {
    if (this._viewModeIndex > 0) {
      // no one view mode active
      return;
    }

    if (this.viewer2DElement.style.opacity === '0') {
      this._activateAndShow2DViewer();
    } else {
      this._deactivateAndHide2DViewer();
    }
  }

  private _handleViewerResizeEvent() {
    this._updateViewerSize();
  }

  private _updateViewerSize() {
    if (this._viewModeIndex == 0) {
      // oneview sync mode
      this._viewerAspectRatio =
        this.viewerBase.offsetWidth / this.viewerBase.offsetHeight; // has to be before resizing"

      this.viewer3DElement.resize(
          this.viewerBase.offsetHeight,
          this.viewerBase.offsetWidth,
      ); // first resize 3d and after resize 2d!
      this.viewer2DElement.resize(
          this.viewerBase.offsetHeight,
          this.viewerBase.offsetWidth,
          'translate(0,0)',
      );

      if (
        this._syncSettings2DViewer == null ||
        this._syncSettings3DViewer == null
      ) {
        return;
      }

      const scaleFactor =
        this._syncSettings2DViewer.imageAspectRatio / this._viewerAspectRatio;
      const correctedFov = this._syncSettings3DViewer.fovInRad * scaleFactor;
      this.viewer3DElement.setReferenceFieldOfView(
          correctedFov,
          this._viewModeIndex < 2,
      );

      this._synchronize3DViewer();
      return;
    }

    this._isColumnDir =
      this.viewerBase.offsetHeight > this.viewerBase.offsetWidth; //

    if (this._syncSettings2DViewer != null) {
      const filledRelArea =
        (this._syncSettings2DViewer.imageAspectRatio *
          this.viewerBase.offsetHeight) /
        this.viewerBase.offsetWidth;
      this._isColumnDir = filledRelArea > 1 ? true : false;
    }

    let newViewerWidth = this.viewerBase.offsetWidth;
    let newViewerHeight = this.viewerBase.offsetHeight * 0.5;
    let viewerTranslateString = 'translate(0,100%)';

    if (!this._isColumnDir) {
      newViewerWidth = this.viewerBase.offsetWidth * 0.5;
      newViewerHeight = this.viewerBase.offsetHeight;
      viewerTranslateString = 'translate(100%,0)';
    }

    this._viewerAspectRatio = newViewerWidth / newViewerHeight; // has to be before resizing"

    this.viewer3DElement.resize(newViewerHeight, newViewerWidth); // first resize 3d and after resize 2d!
    this.viewer2DElement.resize(
        newViewerHeight,
        newViewerWidth,
        viewerTranslateString,
    );
    this.requestUpdate();

    if (
      this._syncSettings2DViewer == null ||
      this._syncSettings3DViewer == null
    ) {
      return;
    }

    const scaleFactor =
      this._syncSettings2DViewer.imageAspectRatio / this._viewerAspectRatio;
    const correctedFov = this._syncSettings3DViewer.fovInRad * scaleFactor;
    this.viewer3DElement.setReferenceFieldOfView(correctedFov, true);
    this._synchronize3DViewer();
  }

  private _changeSyncMode(): void {
    if (this._viewModeIndex < 2) {
      // sync mode is active

      this.viewer3DElement.updateRadiusMode(true);
      this._synchronize3DViewer();
      this.viewer3DElement.disablePan = true;
    } else {
      this.viewer3DElement.disablePan = false;
      this.viewer3DElement.updateRadiusMode(false);
      this.viewer3DElement.setViewerOffset(0, 0);
    }
  }

  private _handleFovBasedZoomChanged(event: CustomEvent): void {
    if (this._viewModeIndex == 2) {
      // no sync mode
      return;
    }

    this.viewer2DElement.zoomImage(event.detail.zoomLevel);
  }

  private _handleImageZoomChanged(event: CustomEvent): void {
    if (this._viewModeIndex < 2) {
      this.viewer3DElement.zoomTo(event.detail.zoomLevel);
    }
  }

  private _handleImageMinZoomLevelChanged(event: CustomEvent): void {
    this.viewer3DElement.setMinZoomLevel(event.detail.zoomLevel);
  }

  private _handleImageShifted(event: CustomEvent): void {
    if (this._viewModeIndex < 2) {
      this.viewer3DElement.setViewerOffset(
          event.detail.deltaX,
          event.detail.deltaY,
      );
    }
  }

  private async _updateViewer(): Promise<void> {
    const updateToken = ++this._viewerUpdateToken;
    const cam3DViewer = this.viewer3DElement.getCamera();
    [this._syncSettings2DViewer, this._syncSettings3DViewer] =
      this._imageCamera.getSyncSettingsOfNextBestImage(cam3DViewer);

    if (
      this._syncSettings2DViewer == null ||
      this._syncSettings3DViewer == null
    ) {
      return;
    }

    this._viewerSettings.imageRotation.autoRotationAngle =
      this._syncSettings2DViewer.rotationAngle;

    const currentImageIdx = this._syncSettings2DViewer.imageIdx;
    await this.viewer2DElement.loadNextImage(currentImageIdx);

    if (updateToken != this._viewerUpdateToken) {
      return;
    }

    const currentSensor = this._imageCamera.getImageSensor(currentImageIdx);
    if (currentSensor == null) {
      console.log('There is no sensor to the image index ', currentImageIdx);
    } else {
      this._viewerSettings.measurementTool.imageSensor = currentSensor;
    }

    this._viewerSettings.measurementTool.imageCamOrientation =
      this._imageCamera.getCameraPose(currentImageIdx);

    const scaleFactor =
      this._syncSettings2DViewer.imageAspectRatio / this._viewerAspectRatio;
    const correctedFov = this._syncSettings3DViewer.fovInRad * scaleFactor;
    if (!this._isInit) {
      this.viewer3DElement.setReferenceFieldOfView(correctedFov, true);
      this.viewer3DElement.setCameraOrbitPos(
          this._syncSettings3DViewer.orbitPos,
      );
      this._updateViewerSize();
      this._isInit = true;
    } else {
      this.viewer3DElement.setReferenceFieldOfView(
          correctedFov,
          this._viewModeIndex < 2,
      );
    }

    if (this._viewModeIndex < 2) {
      this._synchronize3DViewer();
    }
  }

  private _synchronize3DViewer(): void {
    if (
      this._syncSettings3DViewer == null ||
      this._syncSettings2DViewer == null
    ) {
      return;
    }

    this.viewer3DElement.setCameraOrbitPos(this._syncSettings3DViewer.orbitPos);
    this.viewer3DElement.cameraTarget =
      this._syncSettings3DViewer.cameraTarget.toString();
    this.viewer3DElement.zoomTo(this.viewer2DElement.getZoomLevel());
  }

  static styles = css`
    :host {
      width: 100%;
      height: 100%;
      display: flex;
      justify-content: center;
      align-items: center;
    }

    #viewerBase {
      position: relative;
      border: 2px solid blue;
      width: 100%;
      height: 100%;
      min-height: 480px;
      border: 0;
      background-color: lightgray;
    }

    #viewer2D {
      position: absolute;
      left: 0;
      right: 0;
      z-index: 2;
      opacity: 1;
    }

    #viewer3D {
      position: absolute;
      z-index: 1;
      overflow: hidden;
    }

    #controls {
      position: absolute;
      width: 100%;
      height: 100%;
      left: 0;
      right: 0;
      z-index: 5;
      pointer-events: none;
    }

    .hotspot {
      display: block;
      border-radius: 20px;
      border: none;
      background-color: #fff;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.25);
      box-sizing: border-box;
      cursor: pointer;
      transition: opacity 0.3s;
      position: relative;
      font-size: 12px;
      padding: 2px 6px;
    }

    .hotspot:not([data-visible]) {
      background: transparent;
      border: 3px solid #fff;
      box-shadow: none;
      pointer-events: none;
    }

    .hotspot:focus {
      border: 3px solid rgb(0, 128, 200);
      outline: none;
    }

    .hotspot > * {
      opacity: 1;
    }

    .annotation {
      background: rgba(0, 0, 0, 0.75);
      color: rgba(255, 255, 255);
      border-radius: 5px;
      border: 0;
      box-shadow: 0;
      width: max-content;
      padding: 0.25em 0.5em;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    'photogrammetry-viewer': PhotogrammetryViewer;
  }
}

/*

    */
