void main() {
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5) discard;

  float alpha = 1.0 - d * 2.0;
  gl_FragColor = vec4(0.4, 0.8, 1.0, alpha*0.8);
}
