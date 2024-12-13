# Photogrammetry-Viewer
```console
npm i photogrammetry-viewer
```
This library provides an HTML web component that displays photogrammetric data. The component consists of a combined 3D and 2D viewer. For each view of the 3D model, the 2D image closest to the view is loaded. For this to be possible, the camera positions created during the photogrammetric calculations must be exported. At the moment only the xml format from Agisoft is accepted.

## Basic usage 
```html
<html>
  <head>
    <!-- load viewer web component -->
    <script src="https://cdn.jsdelivr.net/npm/@ulb-darmstadt/photogrammetry-viewer/dist/photogrammetry-viewer.js" type="module"></script>
  </head>
  <body>
    <photogrammetry-viewer isYupTransformApplied
      srcScanInformation='http://localhost:8000/Leptinotarsa_decemlineata_NOKI_metashape_cameras.xml' 
      src3D = 'http://localhost:8000/Yup.gltf'
      src2D = 'http://localhost:8000/edof/'>
    </photogrammetry-viewer>
  </body>

</html>
```


## Element attributes
Attribute | Description 
---|---
isYupTransformApplied | indicates whether a z-up to y-up coordinate transformation has been subsequently performed.
srcScanInformation | Exported cameras in xml file from Agisoft
src3D | 3D model in gltf file format
src2D | Path where all 2D images are located. Currently these must be in png format.
loadMeasurement | If this attribute is set, the viewer will try to load measurement data from the file `measurement.json` located in the same path as the GLTF file. See section [Measurements](#Measurements)
viewSettings | An object with additional settings to adjust the viewer. Currently, it may have a property `skyBoxImage` with an URL to the image to be used for the sky-box in the 3D viewer, and a method `async resolve2dFileURL(key: string)`, that resolves the identifier from the XML file to an URL of the 2D image.

## Measurements

Measurements can be downloaded as CSV or JSON from within the measurement tool. In conjunction with the attribute `loadMeasurement`, the JSON file can be used to annotate the 3D model.
