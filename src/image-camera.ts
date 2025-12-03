import {Vector3, Matrix4, Quaternion, Camera, Vector2, Euler} from 'three';
import {ScanInformation} from './scan-information';
import {Settings2DViewer, Settings3DViewer} from './sync-settings';
import {SphericalPosition} from '@google/model-viewer/lib/features/controls';
import {Sensor} from './sensor';
import {toVector3D} from '@google/model-viewer/lib/model-viewer-base';
import {EventEmitter} from 'events';
import {EulerYXZ} from './eulerYXZ';
import {normalizeDeg, radToDeg} from './angle-math-utils';

export class ImageCamera extends EventEmitter {
  // extrinsic:
  poses: Array<Matrix4> = [];
  normedPositions: Array<Vector3> = [];

  private _remapCoordinates: Vector3 = new Vector3(0, 1, 2);

  private _sensorMap = new Map<string, Sensor>();
  private _sensorIds: Array<string> = [];

  private _camPosesInChunk: Array<Matrix4> = [];
  private _chunkToWorldTransform: Matrix4 = new Matrix4();
  private _additionalRotation: Matrix4 = new Matrix4();

  init(scanInformation: ScanInformation, additionalRotation: Euler) {
    this._sensorMap = scanInformation.sensorMap;
    this._sensorIds = scanInformation.sensorIds;

    this._camPosesInChunk = scanInformation.camPosesInChunk;
    this._chunkToWorldTransform = scanInformation.transformationChunkToWorld;
    this._additionalRotation = this._additionalRotation.makeRotationFromEuler(additionalRotation);
    this._calculateCamPosesInWorldCoor();
  }

  setAdditionalRotation(additionalRotation: EulerYXZ): void {
    console.log('Set additional rotation');
    this._additionalRotation = this._additionalRotation.makeRotationFromEuler(
        additionalRotation.angleInRad,
    );
    this._calculateCamPosesInWorldCoor();
    this.emit('camera-parameters-changed');
  }

  setAxesRemapping(newMapping: Vector3) {
    console.log('Set new axes mapping');
    this._remapCoordinates = newMapping;
    this._calculateCamPosesInWorldCoor();
    this.emit('camera-parameters-changed');
  }

  getImageSensor(imageIdx: number): Sensor | undefined {
    const sensorId = this._sensorIds[imageIdx];
    return this._sensorMap.get(sensorId);
  }

  getCameraPose(imageIdx: number): Matrix4 {
    if (imageIdx < this.poses.length && imageIdx >= 0) {
      return this.poses[imageIdx];
    } else {
      return new Matrix4();
    }
  }

  getSyncSettingsOfNextBestImage(viewerCamera: Camera): [Settings2DViewer, Settings3DViewer] | [null, null] {
    let normed3DCamPosition = viewerCamera.position.clone().normalize();
    normed3DCamPosition = new Vector3(
        normed3DCamPosition.getComponent(this._remapCoordinates.getComponent(0)),
        normed3DCamPosition.getComponent(this._remapCoordinates.getComponent(1)),
        normed3DCamPosition.getComponent(this._remapCoordinates.getComponent(2)),
    );

    // get next best image idx
    let minAngle = Number.MAX_VALUE;
    let idxMinAngle = -1;
    for (let i = 0; i < this.normedPositions.length; i++) {
      if (typeof this.normedPositions[i] === 'undefined' || this.normedPositions[i] === null) {
        continue;
      }
      const angle = Math.acos(normed3DCamPosition.dot(this.normedPositions[i])); // faster than .angleTo, as the vectors are already normalised
      if (angle < minAngle) {
        minAngle = angle;
        idxMinAngle = i;
      }
    }

    if (idxMinAngle == -1) {
      return [null, null];
    }

    // extract image pose of next best image
    const xDirImageCam = new Vector3();
    const yDirImageCam = new Vector3();
    const zDirImageCam = new Vector3();
    this.poses[idxMinAngle].extractBasis(
        xDirImageCam,
        yDirImageCam,
        zDirImageCam,
    );

    // extract image pose of next best image
    const phiImageCam = Math.acos(-zDirImageCam.y);
    const thetaImageCam = Math.atan2(-zDirImageCam.x, -zDirImageCam.z);

    // calculate ideal spherical x and y axis:
    const unrotatedImgCamAxisX = new Vector3(
        Math.cos(thetaImageCam),
        0,
        -Math.sin(thetaImageCam),
    );
    const unrotatedImgCamAxisY = new Vector3(
        -Math.cos(phiImageCam) * Math.sin(thetaImageCam),
        Math.sin(phiImageCam),
        -Math.cos(phiImageCam) * Math.cos(thetaImageCam),
    );

    // project x camera axis to ideal rotated x and y axis
    const projectedXDirCam2D = new Vector2();
    projectedXDirCam2D.x = xDirImageCam.dot(unrotatedImgCamAxisX);
    projectedXDirCam2D.y = xDirImageCam.dot(unrotatedImgCamAxisY);
    projectedXDirCam2D.normalize();

    // calculate rotation angle:
    const rotAngle = normalizeDeg(
        radToDeg(Math.atan2(projectedXDirCam2D.y, projectedXDirCam2D.x)),
    );

    // output debug info
    console.log('Computing sync settings of next best image', {
      rotAngle: rotAngle,
      idxMinAngle: idxMinAngle,
      minAngle: minAngle,
      normedPosition: this.normedPositions[idxMinAngle],
      pose: this.poses[idxMinAngle],
      unrotatedImgCamAxisX: unrotatedImgCamAxisX,
      normed3DCamPosition: normed3DCamPosition,
      projectedXDirCam2D: projectedXDirCam2D,
      phiImageCam: phiImageCam,
      thetaImageCam: thetaImageCam,
      nNormedPositions: this.normedPositions.length,
    });

    // set new image cam position
    const imageCamPos = new Vector3();
    imageCamPos.setFromMatrixPosition(this.poses[idxMinAngle]);
    const radius = imageCamPos.length();

    const sphericalPos: SphericalPosition = {
      theta: thetaImageCam,
      phi: phiImageCam,
      radius: radius,
      toString() {
        return `${this.theta}rad ${this.phi}rad ${this.radius}m`;
      },
    };

    const camTargetPos = new Vector3();
    camTargetPos.x =
      imageCamPos.x - radius * Math.sin(phiImageCam) * Math.sin(thetaImageCam);
    camTargetPos.y = imageCamPos.y - radius * Math.cos(phiImageCam);
    camTargetPos.z =
      imageCamPos.z - radius * Math.sin(phiImageCam) * Math.cos(thetaImageCam);

    const sensorId = this._sensorIds[idxMinAngle];
    const sensor = this._sensorMap.get(sensorId);

    let fov = Math.PI * 0.25; // Default fov
    let aspectRatio = 1; // default aspect ratio

    if (sensor != undefined) {
      fov = sensor.fovInRad;
      aspectRatio = sensor.aspectRatio;
    }

    const settings2D: Settings2DViewer = {
      imageIdx: idxMinAngle,
      rotationAngle: -rotAngle,
      imageAspectRatio: aspectRatio,
    };
    const settings3D: Settings3DViewer = {
      orbitPos: sphericalPos,
      cameraTarget: toVector3D(camTargetPos),
      fovInRad: fov,
    };

    return [settings2D, settings3D];
  }

  private _calculateCamPosesInWorldCoor(): void {
    const transformationChunkToWorldYUp = this._chunkToWorldTransform.clone();
    const transformationZupToYup = new Matrix4();
    transformationZupToYup.makeRotationX(-Math.PI * 0.5);

    transformationChunkToWorldYUp.premultiply(transformationZupToYup);

    const tmpPos = new Vector3();
    const tmpQuart = new Quaternion();
    const tmpScale = new Vector3();
    this.poses.length = this._camPosesInChunk.length;
    this.normedPositions.length = this._camPosesInChunk.length;

    for (let i = 0; i < this._camPosesInChunk.length; i++) {
      if (
        this._camPosesInChunk[i] == null ||
        typeof this._camPosesInChunk[i] === 'undefined'
      ) {
        continue;
      }

      const camPoseInWorldScaled = new Matrix4();
      camPoseInWorldScaled.multiplyMatrices(
          transformationChunkToWorldYUp,
          this._camPosesInChunk[i],
      );

      camPoseInWorldScaled.premultiply(this._additionalRotation);

      // decompose to remove scaling
      camPoseInWorldScaled.decompose(tmpPos, tmpQuart, tmpScale);
      const correctedScaleValue = new Vector3(1, 1, 1);
      tmpPos.multiplyScalar(1000); // m to mm

      const camPoseInWorld = new Matrix4();
      camPoseInWorld.compose(tmpPos, tmpQuart, correctedScaleValue);
      this.poses[i] = camPoseInWorld;

      const camPosition = new Vector3();
      camPosition.setFromMatrixPosition(camPoseInWorld);

      this.normedPositions[i] = camPosition.normalize();
    }

    console.log('Calculated camera poses in world coordinates', {
      camPosesInChunk: this._camPosesInChunk,
      normedPoses: this.normedPositions,
      poses: this.poses,
    });
  }
}
