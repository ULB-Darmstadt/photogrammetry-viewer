import {LitElement, css, html} from 'lit';
import {customElement, property, query} from 'lit/decorators.js';
import OpenSeadragon, {
  CanvasPressEvent,
  TileEvent,
  ZoomEvent,
} from 'openseadragon';
import {
  SingleClickEventHandler,
  debounce,
  doubleEventHandler,
} from './helper';

import {ViewerSettings} from './viewer-settings';
import {MeasurementTool} from './measurement-tool';
import {PhotogrammetryViewerSettings} from './public-settings';

interface Pointer {
  clientX: number;
  clientY: number;
  id: number;
}

@customElement('viewer-2d')
export class ViewerElement2D extends LitElement {
  @property()
  src2D: string = '';

  @query('#image_viewer')
  parentElement!: HTMLDivElement;

  @query('#overlay')
  hotspotOverlay!: HTMLDivElement;

  @property({type: Object})
  measurementTool!: MeasurementTool;

  @property({type: Object})
  viewSettings!: PhotogrammetryViewerSettings;

  private _imageFiles: Array<string> = [];
  private _currentImageIdx: number = -1;
  private _loadingImageIdx: number = -1;
  private _pendingImageLoad: Promise<void> | null = null;
  private _currentSyncRotationAngle: number = 0;

  private _imageCenter: OpenSeadragon.Point = new OpenSeadragon.Point(0, 0);
  private _deltaX: number = 0;
  private _deltaY: number = 0;
  private _minZoomLevel: number = -1;
  private _lastDoublePressPointer: Pointer = {
    clientX: -1,
    clientY: -1,
    id: -1,
  };
  private _lastDoublePressTimeStamp: number = 0;
  private _isDown: boolean = false;

  private _viewer: OpenSeadragon.Viewer | null = null;
  private _viewerHomeBounds: OpenSeadragon.Rect = new OpenSeadragon.Rect(
      0,
      0,
      0,
      0,
      0,
  );

  get viewer() {
    return this._viewer
  }

  render() {
    return html`
      <div id="image_viewer" @pointermove="${this._handlePointerMove}"></div>
      <div id="overlay"></div>
    `;
  }

  firstUpdated(): void {
    const viewerBase = this.renderRoot.querySelector(
        '#image_viewer',
    ) as HTMLElement;

    if (viewerBase == null) {
      console.log('coudn\'t find element #image_viewer');
      return;
    }

    this._viewer = OpenSeadragon({
      crossOriginPolicy: 'Anonymous',
      element: viewerBase,
      autoResize: true,
      showFullPageControl: false,
      showZoomControl: false,
      showHomeControl: false,
      showNavigator: false,
      navigatorPosition: 'TOP_LEFT',
      minZoomImageRatio: 1,
      maxZoomLevel: 100, // same as 3d viewer
      // maxZoomPixelRatio: 20,
      imageSmoothingEnabled: false,
      visibilityRatio: 1,
      constrainDuringPan: true,
      defaultZoomLevel: 0, // 0 <- fit to view
      placeholderFillStyle: '#FF8800',
      preserveViewport: true,
      // ajaxWithCredentials: false, ?
      loadTilesWithAjax: true,
      imageLoaderLimit: 1,
      zoomPerScroll: 1.4,
      gestureSettingsMouse: {
        scrollToZoom: true,
        clickToZoom: false,
        dblClickToZoom: false,
        pinchToZoom: false,
        // @ts-ignore
        zoomToRefPoint: false,
      },
      gestureSettingsPen: {
        scrollToZoom: true,
        clickToZoom: false,
        dblClickToZoom: false,
        pinchToZoom: false,
        // @ts-ignore
        zoomToRefPoint: false,
      },
      gestureSettingsUnknown: {
        scrollToZoom: true,
        clickToZoom: false,
        dblClickToZoom: false,
        pinchToZoom: false,
        // @ts-ignore
        zoomToRefPoint: false,
      },
      preserveOverlays: true,
    });

    console.log('Viewer 2D', this._viewer, this.clientHeight, this.clientWidth);
    this._viewer.addHandler('resize', this._handleImageResizeEvent.bind(this));
    this._viewer.addHandler('tile-loaded', this._handleTileLoaded.bind(this));
    this._viewer.addHandler('zoom', this._handleZoomChanged.bind(this));
    this._viewer.addHandler('rotate', this._checkIfMinZoomChanged.bind(this));
    this._viewer.addHandler(
        'update-viewport',
        this._checkIfCenterPosIsUpdated.bind(this),
    );
    this._viewer.addHandler(
        'canvas-press',
        doubleEventHandler(this._handleCanvasDoublePressEvent.bind(this)),
    );
    this._viewer.addHandler(
        'viewport-change',
        this._handleViewportChangedEvent.bind(this),
    );

    this._viewer.addOverlay(
        this.hotspotOverlay,
        new OpenSeadragon.Point(0, 0),
        OpenSeadragon.Placement.CENTER,
    );
    this.hotspotOverlay.style.opacity = '0';
    const singleClickEventHandler = new SingleClickEventHandler(
        this.parentElement,
        'pointerdown',
    );
    singleClickEventHandler.on(
        'single-click',
        this._handleSingleClickEvent.bind(this),
    );

    this.measurementTool.on(
        'change-image-hotspot-visibility',
        (showHotspot: boolean) =>
          (this.hotspotOverlay.style.opacity = showHotspot ? '1' : '0'),
    );
    this.measurementTool.on(
        'update-image-hotspot-position-requested',
        this._updateImageHotspotPosition.bind(this),
    );
  }

  connectWithSettings(viewerSettings: ViewerSettings): void {
    viewerSettings.imageRotation.on(
        'rotation-angle-changed',
        this.rotateImage.bind(this),
    );
  }

  resize(height: number, width: number, transformString: string): void {
    this.style.height = height + 'px';
    this.style.width = width + 'px';
    this.style.transform = transformString;
    this._checkIfZoomIsInvalid();
  }

  setImageFiles(imageFiles: Array<string>) {
    this._imageFiles = imageFiles;
    console.log('Image Files has been set');
  }

  async loadNextImage(imageIdx: number): Promise<void> {
    if (imageIdx >= this._imageFiles.length) {
      console.log(
          'Image with index',
          imageIdx,
          'cannot be loaded because only',
          this._imageFiles.length,
          'images exist',
      );
      return;
    }

    if (this._currentImageIdx == imageIdx && this._pendingImageLoad == null) {
      return;
    }

    if (this._loadingImageIdx == imageIdx && this._pendingImageLoad != null) {
      await this._pendingImageLoad;
      return;
    }

    if (this._viewer == null) {
      return;
    }

    const imageUrl = await this.viewSettings.resolve2dFileURL(
        this._imageFiles[imageIdx],
    );

    this._loadingImageIdx = imageIdx;
    this._pendingImageLoad = new Promise<void>((resolve) => {
      if (this._viewer == null) {
        this._loadingImageIdx = -1;
        this._pendingImageLoad = null;
        resolve();
        return;
      }

      const finishImageLoad = () => {
        this._currentImageIdx = imageIdx;
        this._loadingImageIdx = -1;
        this._pendingImageLoad = null;
        resolve();
      };

      this._viewer.addOnceHandler('open', finishImageLoad);
      this._viewer.addOnceHandler('open-failed', finishImageLoad);
      this._viewer.open({
        type: 'image',
        url: imageUrl,
      });
    });
    await this._pendingImageLoad;

    console.log('Loaded image', imageUrl);
  }

  rotateImage(rotationAngle: number): void {
    if (this._currentSyncRotationAngle == rotationAngle) {
      return;
    }

    this._currentSyncRotationAngle = rotationAngle;

    if (this._viewer == null) {
      return;
    }

    this._viewer.viewport.setRotation(this._currentSyncRotationAngle);
    this._checkIfZoomIsInvalid();
  }

  updatePointerEventsState(setToNone: boolean): void {
    this._viewer?.setMouseNavEnabled(!setToNone);
  }

  zoomImage(zoomLevel: number): void {
    if (this._viewer == null || this._viewer.viewport.getZoom() == zoomLevel) {
      return;
    }

    console.log('Zooom image, ', zoomLevel);
    this._viewer.viewport.zoomTo(zoomLevel, undefined, true);
  }

  getZoomLevel(): number {
    if (this._viewer == null) {
      return 1;
    }

    return this._viewer.viewport.getZoom();
  }

  getImageCenter(): [number, number] {
    if (this._viewer == null) {
      return [0, 0];
    }

    const imgCenterInViewer =
      this._viewer.viewport.imageToViewerElementCoordinates(this._imageCenter);
    const deltaX = this.clientWidth * 0.5 - imgCenterInViewer.x;
    const deltaY = this.clientHeight * 0.5 - imgCenterInViewer.y;

    return [deltaX, deltaY];
  }

  private _handlePointerMove(event: PointerEvent) {
    if (
      this._viewer == null ||
      this._viewer.isMouseNavEnabled() ||
      event.pointerId != this._lastDoublePressPointer.id ||
      !this._isDown
    ) {
      return;
    }

    const dx = event.clientX - this._lastDoublePressPointer.clientX;
    const dy = event.clientY - this._lastDoublePressPointer.clientY;

    if (dx === 0 && dy === 0) {
      return;
    }

    this._lastDoublePressPointer.clientX = event.clientX;
    this._lastDoublePressPointer.clientY = event.clientY;

    // don't need to check if mouse is down, because if mouse is up, 3d viewer is "active" and no more pointer events are fired
    this.dispatchEvent(
        new CustomEvent('pointer-move-in-disable-mode', {
          detail: {
            dx: dx,
            dy: dy,
          },
        }),
    );
  }

  private _handlePointerUpAfterDoublePress(event: PointerEvent): void {
    this._isDown = false;
    if (this._viewer == null || this._viewer.isMouseNavEnabled()) {
      return;
    }

    if (event.timeStamp - this._lastDoublePressTimeStamp > 700) {
      this.dispatchEvent(new Event('double-press-completed'));
    }
  }

  private _updateImageHotspotPosition(xImageCoor: number, yImageCoor: number) {
    console.log(
        'Hotspot update-image-hotspot-position',
        xImageCoor,
        yImageCoor,
    );
    if (this._viewer == null) {
      return;
    }

    this._viewer.updateOverlay(
        this.hotspotOverlay,
        this._viewer.viewport.imageToViewportCoordinates(xImageCoor, yImageCoor),
        OpenSeadragon.Placement.CENTER,
    );
  }

  private _handleSingleClickEvent(event: PointerEvent) {
    if (this._viewer == null || !this.measurementTool.isEditModeActive) {
      console.log('Single click event: ignoring, viewer null or measurement tool not active.');
      return;
    }
    const rect = this.parentElement.getBoundingClientRect();
    const viewportPoint = this._viewer.viewport.pointFromPixel(
        new OpenSeadragon.Point(event.clientX - rect.x, event.clientY - rect.y),
    );
    const imageCoor =
      this._viewer.viewport.viewportToImageCoordinates(viewportPoint);

    this.measurementTool.addPointFromImage(imageCoor.x, imageCoor.y);

    this._viewer.updateOverlay(
        this.hotspotOverlay,
        viewportPoint,
        OpenSeadragon.Placement.CENTER,
    );
    console.log('Hotspot in image added');
  }

  private _handleCanvasDoublePressEvent(event: CanvasPressEvent) {
    this._isDown = true;
    const pointerEvent = event.originalEvent as PointerEvent;

    this._lastDoublePressPointer = {
      clientX: pointerEvent.clientX,
      clientY: pointerEvent.clientX,
      id: pointerEvent.pointerId,
    };

    this.dispatchEvent(
        new CustomEvent('double-press', {
          detail: {
            pointerEvent: pointerEvent,
          },
        }),
    );

    if (this._viewer == null) {
      return;
    }

    console.log('Add event handler');
    this._lastDoublePressTimeStamp = pointerEvent.timeStamp;
    this.parentElement.addEventListener(
        'pointerup',
        this._handlePointerUpAfterDoublePress.bind(this),
        {once: true},
    );
  }

  private _checkIfZoomIsInvalid: () => void = debounce(() => {
    if (this._viewer == null) {
      return;
    }

    const viewport = this._viewer.viewport;
    if (viewport.getZoom(true) < viewport.getMinZoom()) {
      console.log('Zoom is invalid', viewport.getZoom(true));
      viewport.applyConstraints();
    }
  }, 250);

  private _handleViewportChangedEvent() {
    if (this._viewer == null) {
      return;
    }

    if (this._viewerHomeBounds.equals(this._viewer.viewport.getHomeBounds())) {
      // if the home bounds are the same, just zoom or pan has changed
      return;
    }

    this._viewerHomeBounds = this._viewer.viewport.getHomeBounds();

    this.dispatchEvent(
        new CustomEvent('image-zoom-changed', {
          detail: {
            zoomLevel: this._viewer.viewport.getZoom(false),
          },
        }),
    );
  }
  private _handleImageResizeEvent() {
    this._checkIfMinZoomChanged();
  }

  private _handleTileLoaded(event: TileEvent) {
    this._checkIfZoomIsInvalid();
    this._checkIfMinZoomChanged();
    this._checkIfCenterPosIsUpdated();

    const imgDim = event.tiledImage.source.dimensions;

    this._imageCenter.x = imgDim.x * 0.5;
    this._imageCenter.y = imgDim.y * 0.5;
  }

  private _checkIfMinZoomChanged() {
    if (this._viewer == null) {
      return;
    }
    if (this._minZoomLevel != this._viewer.viewport.getMinZoom()) {
      this._minZoomLevel = this._viewer.viewport.getMinZoom();
      console.log('emit min zoom changed', this._minZoomLevel);
      this.dispatchEvent(
          new CustomEvent('min-zoom-level-changed', {
            detail: {
              zoomLevel: this._minZoomLevel,
            },
          }),
      );
    }
  }

  private _checkIfCenterPosIsUpdated: () => void = debounce(() => {
    const [deltaX, deltaY] = this.getImageCenter();

    if (this._deltaX != deltaX || this._deltaY != deltaY) {
      this._deltaX = deltaX;
      this._deltaY = deltaY;
      this.dispatchEvent(
          new CustomEvent('image-shifted', {
            detail: {
              deltaX: deltaX,
              deltaY: deltaY,
            },
          }),
      );
    }
  }, 15);

  private _handleZoomChanged(event: ZoomEvent) {
    if (this._viewer == null || event.immediately == true) {
      console.log('Return zoom', event.zoom);
      return;
    }

    console.log('image zoom changed 1', event.zoom);

    this._checkIfZoomIsInvalid();

    this.dispatchEvent(
        new CustomEvent('image-zoom-changed', {
          detail: {
            zoomLevel: event.zoom,
          },
        }),
    );
  }

  static styles = css`
    :host {
      background-color: black;
    }

    #image_viewer {
      height: inherit;
      width: inherit;
      background-color: transparent;
    }

    .hotspot {
      display: block;
      width: 20px;
      height: 20px;
      border-radius: 20px;
      border: none;
      background-color: #fff;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.25);
      box-sizing: border-box;
      cursor: pointer;
      transition: opacity 0.3s;
      position: relative;
      font-size: 12px;
      padding: 0;
    }

    #overlay {
      display: none;
      background-color: transparent;
      opacity: 0;
      width: 20px;
      height: 20px;
      border-radius: 20px;
      border: 3px solid rgb(0, 128, 200);
    }
  `;
}
