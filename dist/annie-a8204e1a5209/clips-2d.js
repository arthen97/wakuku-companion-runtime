// Installed gesture vocabulary, mapped to the native 3D head.
export const CLIPS = {
  attend: {kind: 'gesture', duration: 1.6, when: 'turning attention to the person, a warm hello'},
  nod: {kind: 'gesture', duration: 1.25, when: 'gently nodding yes, acknowledging or accepting'},
  headshake: {kind: 'gesture', duration: 1.4, when: 'gently shaking the head no'},
  tilt: {kind: 'gesture', duration: 1.6, when: 'a small sympathetic or curious head tilt'},
  settle: {kind: 'gesture', duration: 1.4, when: 'settling down and giving the person space'},
};
export const ACTION_CLIPS = Object.keys(CLIPS);
