"use client";

import React from "react";
import type * as THREE from "three";

/**
 * A glTF viewer for a released part.
 *
 * three.js rather than a product viewer: a CAD record wants edge outlines,
 * lighting that follows the camera so no face goes dark mid-rotation, and
 * ordinary CAD camera controls (pan, zoom to cursor, standard views,
 * orthographic) — none of which <model-viewer> offers.
 *
 * Bundled rather than pulled from a CDN: nothing else in this application
 * loads a script from another origin, and a viewer that stops working when a
 * CDN is unreachable is not much of a record.
 *
 * It is heavy, so it is imported inside an effect rather than at module scope.
 * Next then splits it into its own chunk, fetched when somebody asks to see a
 * model and never by anyone who does not.
 */

type Status = "idle" | "loading" | "ready" | "failed";

type ViewName = "iso" | "front" | "back" | "right" | "left" | "top" | "bottom";

/** What the React toolbar can ask the scene to do. Filled in once it exists. */
type SceneApi = {
  setView: (v: ViewName) => void;
  fit: () => void;
  setEdges: (on: boolean) => void;
  setOrtho: (on: boolean) => void;
  setWireframe: (on: boolean) => void;
  /** A studio still of the current view — see renderStill below. */
  renderStill: (opts: StillOptions) => Promise<Blob>;
};

export type StillBackground = "studio" | "white" | "transparent";
type StillOptions = { width: number; background: StillBackground };

/** Longest side of a still. Under every GPU's drawing-buffer limit (4096). */
const STILL_WIDTH = 2400;

/** A point worth marking on the model — currently only its center of mass. */
export type ModelHotspot = {
  /** [x, y, z] in the model's own coordinate frame, in metres. */
  positionM: [number, number, number];
  label: string;
};

/**
 * Above this many triangles the outlines are not drawn until asked for.
 * Finding feature edges walks every triangle, which on a big assembly is a
 * visible stall before the model has appeared at all.
 */
const AUTO_EDGE_TRIANGLE_LIMIT = 600_000;

/** Feature edges are drawn where adjacent faces meet at more than this. */
const EDGE_ANGLE_DEG = 30;

const VIEWS: { name: ViewName; label: string }[] = [
  { name: "iso", label: "Iso" },
  { name: "front", label: "Front" },
  { name: "back", label: "Back" },
  { name: "left", label: "Left" },
  { name: "right", label: "Right" },
  { name: "top", label: "Top" },
  { name: "bottom", label: "Bottom" },
];

export function ModelViewer({
  src,
  label,
  height = 320,
  /**
   * The part's existing 2D render, if one has been cached — see PartThumb.
   * Shown in place of an empty box for every phase before the model itself
   * has anything to draw: while the library is loading, and again while the
   * glTF downloads. A part that already has a thumbnail then never shows a
   * blank placeholder at all, just a 2D image that becomes a 3D one.
   */
  poster,
  /**
   * Marked on the model once mass properties have actually been measured —
   * see PartDetail's Mass properties card. Not fetched here: that is a live
   * Onshape call, and a viewer nobody asked to measure anything should not
   * spend one.
   */
  hotspot,
  /**
   * Offered beside Download on a render — the configurator keeps one as the
   * configuration's picture. Omitted, a render can only be downloaded.
   */
  onSaveRender,
  /** File name for a downloaded render, without extension. */
  renderName,
}: {
  src: string;
  label: string;
  height?: number;
  poster?: string;
  hotspot?: ModelHotspot;
  onSaveRender?: { label: string; save: (image: Blob) => Promise<void> };
  renderName?: string;
}) {
  const [status, setStatus] = React.useState<Status>("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [edges, setEdgesState] = React.useState(true);
  const [ortho, setOrthoState] = React.useState(false);
  const [wire, setWireState] = React.useState(false);
  const [edgesAvailable, setEdgesAvailable] = React.useState(true);
  // A render: null when closed; the image once made.
  const [still, setStill] = React.useState<{ background: StillBackground; url: string | null; blob: Blob | null; busy: boolean; error: string | null; saved: string | null } | null>(null);

  const mountRef = React.useRef<HTMLDivElement>(null);
  const apiRef = React.useRef<SceneApi | null>(null);
  const hotspotElRef = React.useRef<HTMLButtonElement>(null);
  // Read inside the render loop, which must not be torn down when it changes.
  const hotspotRef = React.useRef<ModelHotspot | undefined>(hotspot);
  hotspotRef.current = hotspot;

  /*
   * The whole scene lives in one effect keyed on the model, not on the
   * toolbar state: rebuilding a WebGL context because somebody toggled the
   * outlines would be a visible flash and a leak waiting to happen. Toolbar
   * changes go through apiRef instead.
   */
  // Not `status` itself: it moves loading -> ready when the scene finishes, and
  // an effect keyed on that would tear the scene down the instant it appeared.
  const active = status === "loading" || status === "ready";
  React.useEffect(() => {
    if (!active) return;
    let disposed = false;
    let cleanup: (() => void) | null = null;

    (async () => {
      try {
        const [THREE, { OrbitControls }, { GLTFLoader }, { RoomEnvironment }] = await Promise.all([
          import("three"),
          import("three/examples/jsm/controls/OrbitControls.js"),
          import("three/examples/jsm/loaders/GLTFLoader.js"),
          import("three/examples/jsm/environments/RoomEnvironment.js"),
        ]);
        if (disposed || !mountRef.current) return;
        const mount = mountRef.current;

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.05;
        renderer.domElement.style.cssText = "display:block;width:100%;height:100%;outline:none;touch-action:none";
        mount.appendChild(renderer.domElement);

        const scene = new THREE.Scene();

        /*
         * Lighting. A soft image-based environment gives metals and plastics
         * their shape; the headlight rides on the camera so the face being
         * looked at is always lit, whichever way the part has been turned.
         */
        const pmrem = new THREE.PMREMGenerator(renderer);
        const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
        scene.environment = envTexture;
        scene.environmentIntensity = 0.3;
        scene.add(new THREE.HemisphereLight(0xffffff, 0x8890a0, 0.2));

        const perspective = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
        const orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
        let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = perspective;
        scene.add(perspective, orthographic);

        const headlight = new THREE.DirectionalLight(0xffffff, 1.3);
        headlight.position.set(0.5, 0.7, 1);
        const fill = new THREE.DirectionalLight(0xffffff, 0.5);
        fill.position.set(-1, -0.3, 0.4);
        // Children of the active camera, so they follow it; moved across on a
        // projection switch.
        perspective.add(headlight, fill);
        headlight.target.position.set(0, 0, -1);
        fill.target.position.set(0, 0, -1);
        perspective.add(headlight.target, fill.target);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.12;
        controls.zoomToCursor = true;
        controls.screenSpacePanning = true;

        let dirty = true;
        const invalidate = () => { dirty = true; };
        controls.addEventListener("change", invalidate);

        const loader = new GLTFLoader();
        const gltf = await loader.loadAsync(src);
        if (disposed) {
          renderer.dispose();
          return;
        }
        const model = gltf.scene;
        scene.add(model);

        /*
         * Outlines. Drawn from the mesh's own geometry at a crease angle, so
         * they mark real edges rather than every tessellation seam. Pushed
         * slightly behind the surface so they never z-fight with it.
         */
        let triangles = 0;
        const meshes: THREE.Mesh[] = [];
        model.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          meshes.push(m);
          const g = m.geometry;
          triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          for (const mat of mats) {
            mat.polygonOffset = true;
            mat.polygonOffsetFactor = 1;
            mat.polygonOffsetUnits = 1;
            // Some exporters leave faces single-sided; a part is a closed
            // solid, but a thin sheet body is not.
            mat.side = THREE.DoubleSide;
          }
        });

        const edgeMaterial = new THREE.LineBasicMaterial({
          color: 0x14181f, transparent: true, opacity: 0.7,
        });
        const edgeLines: THREE.LineSegments[] = [];
        let edgesBuilt = false;
        const buildEdges = () => {
          if (edgesBuilt) return;
          edgesBuilt = true;
          for (const m of meshes) {
            const lines = new THREE.LineSegments(
              new THREE.EdgesGeometry(m.geometry, EDGE_ANGLE_DEG),
              edgeMaterial
            );
            lines.raycast = () => {};
            m.add(lines);
            edgeLines.push(lines);
          }
        };
        const overLimit = triangles > AUTO_EDGE_TRIANGLE_LIMIT;
        if (!overLimit) buildEdges();
        setEdgesAvailable(true);
        if (overLimit) setEdgesState(false);

        /* ---------------------------- framing ----------------------------- */

        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const radius = Math.max(size.length() / 2, 1e-6);

        const dirs: Record<ViewName, [number, number, number]> = {
          iso: [1, 0.8, 1.15],
          front: [0, 0, 1],
          back: [0, 0, -1],
          right: [1, 0, 0],
          left: [-1, 0, 0],
          top: [0, 1, 0.0001],
          bottom: [0, -1, 0.0001],
        };

        const sizeOrtho = () => {
          const w = mount.clientWidth || 1;
          const h = mount.clientHeight || 1;
          const aspect = w / h;
          const half = radius * 1.15;
          orthographic.left = -half * aspect;
          orthographic.right = half * aspect;
          orthographic.top = half;
          orthographic.bottom = -half;
          orthographic.updateProjectionMatrix();
        };

        const setView = (name: ViewName) => {
          const d = new THREE.Vector3(...dirs[name]).normalize();
          const dist = radius / Math.sin((perspective.fov * Math.PI) / 360) * 1.05;
          camera.position.copy(center).addScaledVector(d, dist);
          camera.up.set(0, 1, 0);
          camera.near = Math.max(radius / 200, 1e-4);
          camera.far = dist + radius * 20;
          if (camera === orthographic) {
            orthographic.zoom = 1;
            sizeOrtho();
          }
          camera.updateProjectionMatrix();
          controls.target.copy(center);
          controls.minDistance = radius * 0.02;
          controls.maxDistance = radius * 20;
          controls.update();
          invalidate();
        };

        const switchCamera = (to: typeof camera) => {
          if (to === camera) return;
          to.position.copy(camera.position);
          to.quaternion.copy(camera.quaternion);
          to.up.copy(camera.up);
          to.near = camera.near;
          to.far = camera.far;
          // Keep lights on whichever camera is live.
          to.add(headlight, fill, headlight.target, fill.target);
          if (to === orthographic) {
            sizeOrtho();
            // Match the apparent size the perspective view had at the target.
            const dist = camera.position.distanceTo(controls.target);
            const halfH = dist * Math.tan((perspective.fov * Math.PI) / 360);
            orthographic.zoom = Math.max((radius * 1.15) / Math.max(halfH, 1e-9), 1e-3);
          }
          to.updateProjectionMatrix();
          camera = to;
          (controls as { object: THREE.Camera }).object = to;
          controls.update();
          invalidate();
        };

        /* ------------------------------ stills ------------------------------
         *
         * A studio render of whatever view is on screen, on this same renderer
         * (a second WebGL context could not share the environment map): for
         * one frame, a key light that casts a soft shadow onto an invisible
         * floor, more environment light and no outlines, at STILL_WIDTH; then
         * everything is put back. The model is Y-up, as the configurator's is.
         */
        const floor = new THREE.Mesh(
          new THREE.PlaneGeometry(radius * 40, radius * 40),
          new THREE.ShadowMaterial({ opacity: 0.22 })
        );
        floor.rotation.x = -Math.PI / 2;
        floor.position.set(center.x, box.min.y - radius * 0.002, center.z);
        floor.receiveShadow = true;
        floor.visible = false;
        scene.add(floor);
        const key = new THREE.DirectionalLight(0xffffff, 1.6);
        key.position.set(center.x + radius * 1.6, center.y + radius * 3.2, center.z + radius * 2.2);
        key.target.position.copy(center);
        key.castShadow = true;
        key.shadow.mapSize.set(2048, 2048);
        key.shadow.radius = 6;
        key.shadow.bias = -0.0004;
        key.shadow.normalBias = radius * 0.004;
        const sc = key.shadow.camera as THREE.OrthographicCamera;
        sc.left = -radius * 2.2; sc.right = radius * 2.2; sc.top = radius * 2.2; sc.bottom = -radius * 2.2;
        sc.near = radius * 0.1; sc.far = radius * 10;
        key.visible = false;
        scene.add(key, key.target);
        for (const m of meshes) { m.castShadow = true; m.receiveShadow = true; }

        const renderStill = async ({ width, background }: StillOptions): Promise<Blob> => {
          const w0 = mount.clientWidth || 1, h0 = mount.clientHeight || 1;
          const w = Math.round(width), h = Math.round(width * (h0 / w0));
          const before = {
            ratio: renderer.getPixelRatio(), env: scene.environmentIntensity, head: headlight.intensity,
            fill: fill.intensity, edges: edgeLines.map((l) => l.visible), exposure: renderer.toneMappingExposure,
          };
          renderer.shadowMap.enabled = true;
          renderer.shadowMap.type = THREE.PCFShadowMap;
          for (const m of meshes) for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.needsUpdate = true;
          /*
           * The key light sits high and to the camera's left, a little behind
           * the model, so its shadow falls forward and to the right — where the
           * camera can see it — rather than hiding behind the model.
           */
          const toCam = camera.position.clone().sub(center).setY(0);
          if (toCam.lengthSq() < 1e-12) toCam.set(0, 0, 1);
          toCam.normalize();
          const camLeft = new THREE.Vector3(-toCam.z, 0, toCam.x);
          key.position.copy(center)
            .addScaledVector(new THREE.Vector3(0, 1, 0), radius * 3.4)
            .addScaledVector(camLeft, radius * 1.5)
            .addScaledVector(toCam, -radius * 0.6);
          key.target.position.copy(center);
          key.target.updateMatrixWorld();
          floor.visible = true; key.visible = true;
          scene.environmentIntensity = 0.42;
          headlight.intensity = 0.45; fill.intensity = 0.18;
          renderer.toneMappingExposure = 0.95;
          for (const l of edgeLines) l.visible = false;
          renderer.setPixelRatio(1);
          renderer.setSize(w, h, false);
          perspective.aspect = w / h;
          perspective.updateProjectionMatrix();
          if (camera === orthographic) {
            const half = radius * 1.15;
            orthographic.left = -half * (w / h); orthographic.right = half * (w / h);
            orthographic.updateProjectionMatrix();
          }
          let url = "";
          try {
            renderer.setClearColor(0x000000, 0);
            renderer.render(scene, camera);
            // Read now, before the browser may clear the drawing buffer.
            const out = document.createElement("canvas");
            out.width = w; out.height = h;
            const ctx = out.getContext("2d")!;
            if (background === "studio") {
              const g = ctx.createRadialGradient(w / 2, h * 0.42, h * 0.1, w / 2, h * 0.5, Math.max(w, h) * 0.75);
              g.addColorStop(0, "#ffffff");
              g.addColorStop(1, "#dfe3e8");
              ctx.fillStyle = g;
              ctx.fillRect(0, 0, w, h);
            } else if (background === "white") {
              ctx.fillStyle = "#ffffff";
              ctx.fillRect(0, 0, w, h);
            }
            ctx.drawImage(renderer.domElement, 0, 0, w, h);
            url = out.toDataURL(background === "transparent" ? "image/png" : "image/jpeg", 0.92);
          } finally {
            renderer.shadowMap.enabled = false;
            for (const m of meshes) for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.needsUpdate = true;
            floor.visible = false; key.visible = false;
            scene.environmentIntensity = before.env;
            headlight.intensity = before.head; fill.intensity = before.fill;
            renderer.toneMappingExposure = before.exposure;
            edgeLines.forEach((l, i) => { l.visible = before.edges[i]; });
            renderer.setPixelRatio(before.ratio);
            resize();
          }
          return await (await fetch(url)).blob();
        };

        apiRef.current = {
          renderStill,
          setView,
          fit: () => setView("iso"),
          setEdges: (on) => {
            if (on) buildEdges();
            for (const l of edgeLines) l.visible = on;
            invalidate();
          },
          setOrtho: (on) => switchCamera(on ? orthographic : perspective),
          setWireframe: (on) => {
            for (const m of meshes) {
              const mats = Array.isArray(m.material) ? m.material : [m.material];
              for (const mat of mats) (mat as THREE.MeshStandardMaterial).wireframe = on;
            }
            invalidate();
          },
        };

        /* ----------------------------- sizing ----------------------------- */

        const resize = () => {
          const w = mount.clientWidth || 1;
          const h = mount.clientHeight || 1;
          renderer.setSize(w, h, false);
          perspective.aspect = w / h;
          perspective.updateProjectionMatrix();
          sizeOrtho();
          invalidate();
        };
        const ro = new ResizeObserver(resize);
        ro.observe(mount);
        resize();
        setView("iso");

        /* ------------------------ render loop + hotspot -------------------- */

        const hsVec = new THREE.Vector3();
        let raf = 0;
        const frame = () => {
          raf = requestAnimationFrame(frame);
          if (controls.update()) dirty = true;

          const hs = hotspotRef.current;
          const el = hotspotElRef.current;
          if (el) {
            if (hs) {
              hsVec.set(...hs.positionM);
              model.localToWorld(hsVec);
              hsVec.project(camera);
              const visible = hsVec.z > -1 && hsVec.z < 1;
              el.style.display = visible ? "block" : "none";
              el.style.transform =
                `translate(${(hsVec.x * 0.5 + 0.5) * mount.clientWidth - 7}px,` +
                `${(-hsVec.y * 0.5 + 0.5) * mount.clientHeight - 7}px)`;
            } else {
              el.style.display = "none";
            }
          }

          if (!dirty) return;
          dirty = false;
          renderer.render(scene, camera);
        };
        frame();

        cleanup = () => {
          cancelAnimationFrame(raf);
          ro.disconnect();
          controls.dispose();
          apiRef.current = null;
          model.traverse((o) => {
            const m = o as THREE.Mesh;
            if (!m.isMesh) return;
            m.geometry.dispose();
            const mats = Array.isArray(m.material) ? m.material : [m.material];
            for (const mat of mats) {
              for (const v of Object.values(mat)) {
                if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose();
              }
              mat.dispose();
            }
          });
          for (const l of edgeLines) l.geometry.dispose();
          edgeMaterial.dispose();
          floor.geometry.dispose();
          (floor.material as THREE.Material).dispose();
          key.shadow.map?.dispose();
          envTexture.dispose();
          pmrem.dispose();
          renderer.dispose();
          renderer.forceContextLoss();
          renderer.domElement.remove();
        };

        if (disposed) {
          cleanup();
          cleanup = null;
          return;
        }
        setStatus("ready");
      } catch (e: any) {
        if (disposed) return;
        setError(String(e?.message ?? e));
        setStatus("failed");
      }
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [active, src]);

  const frame: React.CSSProperties = {
    height,
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--surface-2)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    // The part's existing 2D render, so "not loaded yet" looks like the part
    // rather than an empty box. Absent for a part with no cached thumbnail —
    // the frame's plain background then shows through exactly as before.
    ...(poster && {
      backgroundImage: `url(${poster})`,
      backgroundSize: "cover",
      backgroundPosition: "center",
    }),
  };

  if (status === "idle") {
    return (
      <div style={frame}>
        {/*
          * A solid backing behind the button rather than a bare button on top
          * of a photo — otherwise the button reads as part of the image.
          */}
        <button
          className="btn btn-sm"
          onClick={() => setStatus("loading")}
          style={poster ? { background: "var(--surface)", boxShadow: "0 1px 4px rgba(0,0,0,0.25)" } : undefined}
        >
          View in 3D
        </button>
      </div>
    );
  }

  if (status === "failed") {
    return (
      <div style={{ ...frame, flexDirection: "column", gap: 6, padding: 12 }}>
        <span style={{ fontSize: 12.5, color: "var(--danger)" }}>
          The 3D viewer could not load.
        </span>
        <span style={{ fontSize: 11.5, color: "var(--text-faint)", textAlign: "center" }}>
          {error}
        </span>
        <a className="btn btn-sm" href={src} download>Download the model instead</a>
      </div>
    );
  }

  async function makeStill(background: StillBackground) {
    const api = apiRef.current;
    if (!api) return;
    setStill((x) => ({ background, url: x?.url ?? null, blob: null, busy: true, error: null, saved: null }));
    // Let the overlay paint before the frame that blocks the main thread.
    await new Promise((r) => setTimeout(r, 30));
    try {
      const blob = await api.renderStill({ width: STILL_WIDTH, background });
      setStill((x) => {
        if (x?.url) URL.revokeObjectURL(x.url);
        return { background, url: URL.createObjectURL(blob), blob, busy: false, error: null, saved: null };
      });
    } catch (e: any) {
      setStill((x) => x && { ...x, busy: false, error: `The render failed: ${String(e?.message ?? e)}` });
    }
  }

  function closeStill() {
    setStill((x) => { if (x?.url) URL.revokeObjectURL(x.url); return null; });
  }

  const ready = status === "ready";
  const bar: React.CSSProperties = {
    position: "absolute", left: 8, right: 8, bottom: 8,
    display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center",
  };
  const chip = (on?: boolean): React.CSSProperties => ({
    background: on ? "var(--accent, #3c78dc)" : "var(--surface)",
    color: on ? "#fff" : "var(--text)",
    boxShadow: "0 1px 4px rgba(0,0,0,0.25)",
  });

  return (
    <div
      style={{
        ...frame,
        position: "relative",
        overflow: "hidden",
        display: "block",
        // The poster has done its job once there is a scene to look at.
        ...(ready && { backgroundImage: "none" }),
      }}
    >
      <div ref={mountRef} role="img" aria-label={label} style={{ position: "absolute", inset: 0 }} />

      {!ready && (
        <div
          style={{
            position: "absolute", inset: 0, display: "flex",
            alignItems: "center", justifyContent: "center",
            fontSize: 12.5, color: "var(--text-faint)", pointerEvents: "none",
          }}
        >
          <span
            style={{
              background: "var(--surface)", padding: "3px 8px", borderRadius: 4,
              boxShadow: "0 1px 4px rgba(0,0,0,0.25)",
            }}
          >
            Loading the model…
          </span>
        </div>
      )}

      {/* The center of mass, projected onto the canvas every frame. */}
      <button
        ref={hotspotElRef}
        title={hotspot?.label}
        tabIndex={-1}
        style={{
          position: "absolute", left: 0, top: 0, display: "none",
          width: 14, height: 14, borderRadius: "50%", padding: 0,
          background: "var(--accent, #3c78dc)", border: "2px solid white",
          boxShadow: "0 0 0 1px var(--accent, #3c78dc), 0 1px 4px rgba(0,0,0,0.4)",
          cursor: "default", pointerEvents: "none",
        }}
      >
        {hotspot && (
          <span
            style={{
              position: "absolute", left: 18, top: -8, whiteSpace: "nowrap",
              fontSize: 11, fontWeight: 600, color: "var(--text)",
              background: "var(--surface)", border: "1px solid var(--border)",
              borderRadius: 4, padding: "2px 6px", boxShadow: "0 1px 4px rgba(0,0,0,0.2)",
            }}
          >
            {hotspot.label}
          </span>
        )}
      </button>

      {ready && (
        <div style={bar}>
          {VIEWS.map((v) => (
            <button
              key={v.name} className="btn btn-sm" style={chip()}
              onClick={() => apiRef.current?.setView(v.name)}
            >
              {v.label}
            </button>
          ))}
          <button className="btn btn-sm" style={chip()} onClick={() => apiRef.current?.fit()}
            title="Reset to the isometric view, framed to fit">
            Fit
          </button>
          <span style={{ flex: 1 }} />
          <button
            className="btn btn-sm" style={chip(edges)} disabled={!edgesAvailable}
            onClick={() => { const n = !edges; setEdgesState(n); apiRef.current?.setEdges(n); }}
            title="Outline the part's edges"
          >
            Edges
          </button>
          <button
            className="btn btn-sm" style={chip(wire)}
            onClick={() => { const n = !wire; setWireState(n); apiRef.current?.setWireframe(n); }}
            title="Show the mesh as wireframe"
          >
            Wire
          </button>
          <button
            className="btn btn-sm" style={chip(ortho)}
            onClick={() => { const n = !ortho; setOrthoState(n); apiRef.current?.setOrtho(n); }}
            title="Orthographic projection — no perspective foreshortening"
          >
            Ortho
          </button>
          <button
            className="btn btn-sm" style={chip(Boolean(still))}
            onClick={() => void makeStill(still?.background ?? "studio")}
            title="A studio-lit, high-resolution image of this view — soft shadow, clean background"
          >
            Render
          </button>
        </div>
      )}

      {still && (
        <div
          style={{
            position: "absolute", inset: 0, background: "rgba(10,12,16,0.72)", display: "flex",
            flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 12,
          }}
        >
          <div style={{ flex: 1, minHeight: 0, width: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
            {still.url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={still.url} alt={`Render of ${label}`}
                style={{
                  maxWidth: "100%", maxHeight: "100%", borderRadius: 6, boxShadow: "0 2px 12px rgba(0,0,0,0.4)",
                  // A checkerboard behind a transparent render, so the transparency shows.
                  background: still.background === "transparent"
                    ? "repeating-conic-gradient(#d5d8dd 0% 25%, #f3f4f6 0% 50%) 50% / 16px 16px" : undefined,
                }}
              />
            ) : (
              <span style={{ color: "#fff", fontSize: 12.5 }}>{still.error ?? "Rendering…"}</span>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center", alignItems: "center" }}>
            {(["studio", "white", "transparent"] as const).map((b) => (
              <button key={b} className="btn btn-sm" style={chip(still.background === b)} disabled={still.busy}
                onClick={() => void makeStill(b)}>
                {b === "studio" ? "Studio" : b === "white" ? "White" : "Transparent"}
              </button>
            ))}
            <span style={{ width: 8 }} />
            {still.url && (
              <a className="btn btn-sm" style={chip()} href={still.url}
                download={`${renderName || label}.${still.background === "transparent" ? "png" : "jpg"}`}>
                Download
              </a>
            )}
            {onSaveRender && still.blob && (
              <button className="btn btn-sm btn-primary" disabled={still.busy || still.saved !== null}
                onClick={async () => {
                  setStill((x) => x && { ...x, busy: true, error: null });
                  try {
                    await onSaveRender.save(still.blob!);
                    setStill((x) => x && { ...x, busy: false, saved: "Saved." });
                  } catch (e: any) {
                    setStill((x) => x && { ...x, busy: false, error: String(e?.message ?? e) });
                  }
                }}>
                {still.saved ?? onSaveRender.label}
              </button>
            )}
            <button className="btn btn-sm" style={chip()} onClick={closeStill}>Close</button>
          </div>
          {still.error && still.url && <span style={{ color: "#ffb4b4", fontSize: 12 }}>{still.error}</span>}
          <span style={{ color: "rgba(255,255,255,0.7)", fontSize: 11.5 }}>
            Rendered from the view you had — close, turn the model, and render again for another angle.
          </span>
        </div>
      )}
    </div>
  );
}
