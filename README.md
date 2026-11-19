# Fruit Ninja · Camera Arcade

From this project folder, run:

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory dist
```

Open http://localhost:8765 in your browser. Pick Chill, Classic, or Blitz, then select **Enable camera & play** and allow camera access. Move either hand into the falling fruit to slice it for one point. The third miss ends the round. **Practice with pointer** uses your mouse or touch. **End round** releases the camera.

This build reuses ASL Trainer’s MediaPipe Hand Landmarker 0.10.32 browser runtime and pretrained hand model. Its files are bundled under `dist/vision` with the MediaPipe license. Tracking runs in the browser and the game needs no external requests or training data.

- [MediaPipe source](https://github.com/google-ai-edge/mediapipe)
- [Hand Landmarker model](https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task)
