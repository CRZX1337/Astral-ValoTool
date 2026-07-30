/* GLSL for the hero. Kept as template strings so the quality tier can be
   compiled in with a #define swap -- no build step involved. */

/* A fullscreen triangle synthesized from gl_VertexID. No buffers, no
   attributes, no vertex array object to set up. */
export const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export function frag({ steps = 64, inner = 24 } = {}) {
  return `#version 300 es
precision highp float;

uniform vec2  uRes;
uniform float uTime;
uniform vec2  uPointer;
uniform float uScroll;

out vec4 fragColor;

#define STEPS ${steps}
#define INNER ${inner}
#define MAX_DIST 12.0
#define EPS 0.0012

mat3 rotX(float a){ float c=cos(a), s=sin(a); return mat3(1.,0.,0., 0.,c,-s, 0.,s,c); }
mat3 rotY(float a){ float c=cos(a), s=sin(a); return mat3(c,0.,-s, 0.,1.,0., s,0.,c); }
mat3 rotZ(float a){ float c=cos(a), s=sin(a); return mat3(c,-s,0., s,c,0., 0.,0.,1.); }

mat3 gRot;

/* Single key light direction, shared by env() and the specular lobes so the
   highlight and its reflection agree. */
const vec3 KEY = vec3(0.4570, 0.6094, 0.3809); // normalize(vec3(.6,.8,.5))

/* Polar star, after iq. n points, m controls how sharp they are. */
float sdStar(vec2 p, float r, float n, float m) {
  float an = 3.141593 / n;
  float en = 3.141593 / m;
  vec2 acs = vec2(cos(an), sin(an));
  vec2 ecs = vec2(cos(en), sin(en));
  float bn = mod(atan(p.x, p.y), 2.0 * an) - an;
  p = length(p) * vec2(cos(bn), abs(sin(bn)));
  p -= r * acs;
  p += ecs * clamp(-dot(p, ecs), 0.0, r * acs.y / ecs.y);
  return length(p) * sign(p.x);
}

/* Extrude a 2D distance into a slab of half-height h. */
float opExtrude(vec3 p, float d, float h) {
  vec2 w = vec2(d, abs(p.z) - h);
  return min(max(w.x, w.y), 0.0) + length(max(w, 0.0));
}

float map(vec3 p) {
  p = gRot * p;
  float d2 = sdStar(p.xy, 0.62, 4.0, 2.7);
  float d = opExtrude(p, d2, 0.13) - 0.085;

  /* Low-amplitude domain breathing. This is the difference between reading as
     liquid and reading as cut crystal. */
  float w = sin(p.x * 3.1 + uTime * 0.9)
          * sin(p.y * 3.4 - uTime * 0.75)
          * sin(p.z * 2.6 + uTime * 0.6);
  return d + w * 0.05;
}

/* 4-tap tetrahedron normal: same quality as 6-tap central differences for
   two-thirds of the map() calls. */
vec3 normalAt(vec3 p) {
  const float h = 0.0015;
  const vec2 k = vec2(1.0, -1.0);
  return normalize(
    k.xyy * map(p + k.xyy * h) +
    k.yyx * map(p + k.yyx * h) +
    k.yxy * map(p + k.yxy * h) +
    k.xxx * map(p + k.xxx * h)
  );
}

/* The procedural backdrop. It is both what fills the hero and what the glass
   refracts, so the star bends the actual scene rather than a fake cubemap.
   Values are the page's own tokens: #07080b -> #101219, with #6C7AFF,
   #5BB5FF and #ff5a68 blobs. */
vec3 env(vec3 d) {
  d = normalize(d);
  float g = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(vec3(0.027, 0.031, 0.043), vec3(0.063, 0.071, 0.098), g);

  float a = uTime * 0.12;
  vec3 d1 = normalize(vec3(cos(a) * 0.85, 0.55, sin(a) * 0.85));
  vec3 d2 = normalize(vec3(-0.75, -0.2, 0.62));
  vec3 d3 = normalize(vec3(0.25, -0.85, -0.45));

  col += vec3(0.424, 0.478, 1.000) * pow(max(dot(d, d1), 0.0), 4.0) * 0.72;
  col += vec3(0.357, 0.710, 1.000) * pow(max(dot(d, d2), 0.0), 5.0) * 0.66;
  col += vec3(1.000, 0.353, 0.408) * pow(max(dot(d, d3), 0.0), 7.0) * 0.24;

  /* A small, tight key light. Barely visible in the backdrop itself, but it
     gives the glass something crisp to catch and bend. */
  col += vec3(1.0, 0.97, 0.92) * pow(max(dot(d, KEY), 0.0), 180.0) * 2.8;
  return col;
}

/* Everything the glass does at a surface point. Split out of main() so the
   anti-aliasing path can shade a near-miss point with the same code. */
vec3 shade(vec3 p, vec3 rd) {
  vec3 n = normalAt(p);

  float f = pow(1.0 - max(dot(-rd, n), 0.0), 5.0);
  f = 0.04 + 0.96 * f;                       // Schlick, IOR ~1.45

  vec3 refl = env(reflect(rd, n));

  /* Dispersion: the same path traced at three IORs, one per channel. Costs
     three inside-marches and is the whole reason the edges fringe. */
  float iors[3] = float[3](1.44, 1.45, 1.46);
  vec3 refr = vec3(0.0);
  float thickness = 0.0;

  for (int c = 0; c < 3; c++) {
    vec3 rdi = refract(rd, n, 1.0 / iors[c]);

    /* March the negated field to find where the ray leaves the solid. */
    float ti = 0.02;
    for (int j = 0; j < INNER; j++) {
      float di = -map(p + rdi * ti);
      if (di < EPS) break;
      ti += max(di * 0.8, 0.012);
    }
    if (c == 1) thickness = ti;   // green channel stands in for the whole

    vec3 pe = p + rdi * ti;
    vec3 ne = -normalAt(pe);
    vec3 rdo = refract(rdi, ne, iors[c]);
    /* Zero vector means total internal reflection. */
    if (dot(rdo, rdo) < 0.5) rdo = reflect(rdi, ne);

    refr[c] = env(rdo)[c];
  }

  /* Beer-Lambert absorption. Thick parts of the solid go deep blue while
     thin edges stay clear -- this is what gives the star volume instead of
     reading as a flat outline over a dark background. */
  refr *= exp(-thickness * vec3(2.4, 1.4, 0.65));

  vec3 col = mix(refr, refl, f);

  /* Faint internal scatter, so the mass of the star glows from within
     rather than only at its silhouette. */
  col += vec3(0.16, 0.42, 0.95) * (1.0 - exp(-thickness * 1.7)) * 0.34;

  float sp = max(dot(reflect(rd, n), KEY), 0.0);
  col += vec3(1.0) * pow(sp, 90.0) * 1.8;                 // tight glint
  col += vec3(0.75, 0.88, 1.00) * pow(sp, 12.0) * 0.24;   // broad sheen
  col += vec3(0.35, 0.60, 1.00) * f * 0.40;               // fresnel rim
  return col;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;

  /* Two-axis tumble, plus a slow lean toward the pointer. */
  gRot = rotY(uTime * 0.26 + uPointer.x * 0.55)
       * rotX(-0.22 + uTime * 0.16 + uPointer.y * 0.38)
       * rotZ(uTime * 0.06);

  vec3 ro = vec3(0.0, uScroll * 0.7, 3.0);
  vec3 rd = normalize(vec3(uv * 1.08, -1.6));

  /* Half-width of one pixel's cone, per unit of ray distance. Used below to
     turn "how close did we pass" into a coverage value. */
  float px = 1.6 / uRes.y;

  float t = 0.0;
  bool hit = false;
  /* Closest approach, measured in pixel widths, and where it happened. */
  float best = 1e9;
  vec3 pBest = ro + rd * 3.0;

  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * t;
    float d = map(p);

    float ratio = d / max(t * px, 1e-5);
    if (ratio < best) { best = ratio; pBest = p; }

    if (d < EPS) { hit = true; pBest = p; break; }
    /* 0.75 understeps deliberately: the domain warp makes map() slightly
       non-Lipschitz, and full steps would punch through thin points. */
    t += d * 0.75;
    if (t > MAX_DIST) break;
  }

  vec3 bg = env(rd);

  /* Analytic silhouette anti-aliasing. A binary hit test makes the star's
     outline -- and the bright Fresnel rim sitting exactly on it -- stair-step
     badly. Rays that pass within a pixel of the surface instead get partial
     coverage and are shaded from their closest-approach point, which costs
     one extra compare per march step rather than a second sample. */
  float cover = hit ? 1.0 : 1.0 - smoothstep(0.0, 1.0, best);

  vec3 col = bg;
  if (cover > 0.002) col = mix(bg, shade(pBest, rd), cover);

  col = col / (1.0 + col);

  /* Hash dither. Non-optional: a near-black gradient bands badly at 8 bits,
     and the banding is what would make this look cheap. */
  float dh = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  col += (dh - 0.5) / 255.0;

  fragColor = vec4(col, 1.0);
}`;
}
