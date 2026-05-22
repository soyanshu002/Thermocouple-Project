import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

let camera, scene, renderer, controls;
let raycaster, pointer;
let intersected;
let temperatureData = {};
let dates = [];
let thermocoupleMeshes = {}; // Map ID -> Mesh (Head)
let thermocouplePositions = []; // Array of { id, pos: Vector3 }
let isHeatmapMode = true;
let meshOuter, meshInner, wireframe, materialRealistic, materialHeatmap;
let globalProfileData = null;
let isCroppedMode = true;
let isIsolatedMode = false;

let idwWeightsOuter = []; // Pre-computed weights [vertexIndex][tcIndex]
let bottomPlanes = [];
let bottomPlaneWeights = [];
// Storing flat arrays for performance? Or array of objects? 
// For 6000 vertices, array of arrays is fine.

// 2D Isotherm View state variables
let is3DMode = true;
let sliceOrientation2D = 'vertical';
let sliceElevation2D = 7100;
let active2DSlice = '35-215';
let isothermThreshold = 1150;
let showHeatmap2D = true;
let showNodes2D = true;
let showOtherIsotherms = true;
let showOriginalProfile = true;

let canvas2D, ctx2D;
let projectedTCs = [];
let hoveredNode2D = null;

const gridRows = 100;
const gridCols = 150;
let gridValues = [];
let gridR = [];
let gridZ = [];

let scale2D = 1.0;
let offsetX2D = 0;
let offsetY2D = 0;
const minR = -7600;
const maxR = 7600;
const minZ = 3500;
const maxZ = 14100;

let offscreenCanvas = null;
let offscreenCtx = null;

// 2D Zoom & Pan state variables
let zoom2D = 1.0;
let panX2D = 0;
let panY2D = 0;
let isDragging2D = false;
let startDragX = 0;
let startDragY = 0;
let startPanX = 0;
let startPanY = 0;


const tooltip = document.getElementById('tooltip');

init();
animate();

function init() {
    // Scene setup
    scene = new THREE.Scene();
    // Use a dark background to simulate industrial environment or night view
    scene.background = new THREE.Color(0x101010);
    scene.fog = new THREE.FogExp2(0x101010, 0.00002);

    // Camera setup
    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 10, 100000);
    camera.position.set(20000, 15000, 20000);

    // Renderer setup
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.localClippingEnabled = true; // Required for object-level clipping if used, global planes work automatically

    // Tone mapping for realistic lighting
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    document.body.appendChild(renderer.domElement);

    // Controls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.screenSpacePanning = false;
    controls.minDistance = 100;
    controls.maxDistance = 50000;
    controls.target.set(0, 3000, 0); // Aim at middle-lower part of furnace

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.3); // Soft white light
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight.position.set(10000, 20000, 10000);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 50000;
    dirLight.shadow.camera.left = -20000;
    dirLight.shadow.camera.right = 20000;
    dirLight.shadow.camera.top = 20000;
    dirLight.shadow.camera.bottom = -20000;
    scene.add(dirLight);

    // Point lights for furnace glow/highlights
    const pointLight1 = new THREE.PointLight(0xffaa00, 1, 30000);
    pointLight1.position.set(0, 5000, 8000);
    scene.add(pointLight1);

    // Grid Helper (Floor)
    const gridHelper = new THREE.GridHelper(30000, 30, 0x444444, 0x222222);
    scene.add(gridHelper);

    // Axis Coordinate Labels
    const axesMarkers = new THREE.Group();
    for (let i = -15000; i <= 15000; i += 5000) {
        if (i === 0) continue; // Skip origin to avoid clutter

        // X-axis labels (data X maps to ThreeJS X)
        axesMarkers.add(createTextSprite(i.toString(), new THREE.Vector3(i, 50, 0), "#ffaaaa"));

        // Y-axis labels (data Y maps to ThreeJS Z)
        axesMarkers.add(createTextSprite(i.toString(), new THREE.Vector3(0, 50, i), "#aaffaa"));
    }

    // Main Axis Names
    axesMarkers.add(createTextSprite("X Axis", new THREE.Vector3(16000, 50, 0), "#ff4444", 60));
    axesMarkers.add(createTextSprite("Y Axis", new THREE.Vector3(0, 50, 16000), "#44ff44", 60));
    scene.add(axesMarkers);

    // Raycaster for interaction
    raycaster = new THREE.Raycaster();
    pointer = new THREE.Vector2();

    // Load Data
    loadData();

    // Event listeners
    window.addEventListener('resize', onWindowResize);
    document.addEventListener('mousemove', onPointerMove);

    // Initial Slice Mode Setup
    const sliceModeSelect = document.getElementById('sliceMode');
    if (sliceModeSelect) {
        sliceModeSelect.addEventListener('change', () => {
            const mode = sliceModeSelect.value;
            if (mode === 'none') {
                renderer.clippingPlanes = [];
            } else if (mode === 'x') {
                // Slice along X-axis (shows YZ plane)
                renderer.clippingPlanes = [new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0)];
                const targetY = isCroppedMode ? 3000 : 7000;
                controls.target.set(0, targetY, 0);
                camera.position.set(20000, targetY, 0);
            } else if (mode === 'y') {
                // Slice along Y-axis (shows XZ plane) -> In Three.js this is cutting across Z axis
                renderer.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 0, -1), 0)];
                const targetY = isCroppedMode ? 3000 : 7000;
                controls.target.set(0, targetY, 0);
                camera.position.set(0, targetY, 20000);
            }
        });
    }

    // Sector Select Setup
    const sectorSelect = document.getElementById('sectorSelect');
    if (sectorSelect) {
        sectorSelect.addEventListener('change', () => {
            const val = sectorSelect.value;
            if (val === 'all') {
                renderer.clippingPlanes = [];
                // Unhide all TCs
                for (let id in thermocoupleMeshes) thermocoupleMeshes[id].parent.visible = true;
            } else {
                const sIdx = parseInt(val);
                const theta1 = (sIdx * 60) * (Math.PI / 180);
                const theta2 = ((sIdx + 1) * 60) * (Math.PI / 180);

                // Create two clipping planes to form a 60-degree wedge
                // Plane 1: Normal points CCW from theta1
                const n1 = new THREE.Vector3(-Math.sin(theta1), 0, Math.cos(theta1));
                // Plane 2: Normal points CW from theta2
                const n2 = new THREE.Vector3(Math.sin(theta2), 0, -Math.cos(theta2));

                renderer.clippingPlanes = [
                    new THREE.Plane(n1, 0),
                    new THREE.Plane(n2, 0)
                ];

                // Filter TCs: Hide those outside the sector
                // In script.js geometry: theta = atan2(pos.z, pos.x)
                for (let id in thermocoupleMeshes) {
                    const mesh = thermocoupleMeshes[id];
                    const pos = mesh.parent.position;
                    let angle = Math.atan2(pos.z, pos.x);
                    if (angle < 0) angle += Math.PI * 2;
                    
                    const inSector = (angle >= theta1 && angle <= theta2);
                    mesh.parent.visible = inSector;
                }

                // Tilt camera to face the sector
                const midTheta = (theta1 + theta2) / 2;
                const dist = isCroppedMode ? 15000 : 25000;
                const camX = Math.cos(midTheta) * dist;
                const camZ = Math.sin(midTheta) * dist;
                const camY = isCroppedMode ? 8000 : 15000;
                
                // Animate or jump camera
                camera.position.set(camX, camY, camZ);
                const targetY = isCroppedMode ? 3000 : 7000;
                controls.target.set(0, targetY, 0);
            }
        });
    }

    // Export GLTF Setup
    const exportBtn = document.getElementById('exportBtn');
    if (exportBtn) {
        exportBtn.addEventListener('click', exportGLTF);
    }

    // 2D View setup
    canvas2D = document.getElementById('canvas2D');
    if (canvas2D) {
        ctx2D = canvas2D.getContext('2d');
        window.addEventListener('resize', handle2DResize);
        canvas2D.addEventListener('mousemove', onCanvasMouseMove);
        canvas2D.addEventListener('mousedown', onCanvasMouseDown);
        canvas2D.addEventListener('mouseup', onCanvasMouseUp);
        canvas2D.addEventListener('mouseleave', onCanvasMouseLeave);
        canvas2D.addEventListener('wheel', onCanvasWheel, { passive: false });
        canvas2D.addEventListener('dblclick', onCanvasDblClick);
    }

    const btn3D = document.getElementById('btn3D');
    const btn2D = document.getElementById('btn2D');
    const container2D = document.getElementById('container2D');
    const controls3D = document.getElementById('controls3D');
    const controls2D = document.getElementById('controls2D');
    const titleLabel = document.getElementById('titleLabel');
    const instructionLabel = document.getElementById('instructionLabel');

    if (btn3D && btn2D) {
        btn3D.addEventListener('click', () => {
            is3DMode = true;
            btn3D.classList.add('active');
            btn2D.classList.remove('active');
            renderer.domElement.style.display = 'block';
            container2D.style.display = 'none';
            controls3D.style.display = 'block';
            controls2D.style.display = 'none';
            if (titleLabel) titleLabel.textContent = 'Blast Furnace Thermocouple Visualization';
            if (instructionLabel) instructionLabel.innerHTML = 'Left Click: Rotate | Right Click: Pan | Scroll: Zoom';
        });

        btn2D.addEventListener('click', () => {
            is3DMode = false;
            btn2D.classList.add('active');
            btn3D.classList.remove('active');
            renderer.domElement.style.display = 'none';
            container2D.style.display = 'block';
            controls3D.style.display = 'none';
            controls2D.style.display = 'flex';
            if (titleLabel) titleLabel.textContent = 'Blast Furnace Isotherm Cross-Section (2D)';
            if (instructionLabel) instructionLabel.innerHTML = 'Drag: Pan | Scroll: Zoom | Double Click / Button: Reset | Hover: Inspect TCs';
            handle2DResize();
            trigger2DRender();
        });
    }

    const btnToggleControls = document.getElementById('btnToggleControls');
    const mainControlsPanel = document.getElementById('controls');
    if (btnToggleControls && mainControlsPanel) {
        let controlsVisible = true;
        btnToggleControls.addEventListener('click', () => {
            controlsVisible = !controlsVisible;
            if (controlsVisible) {
                mainControlsPanel.style.bottom = '30px';
                mainControlsPanel.style.opacity = '1';
                mainControlsPanel.style.pointerEvents = 'auto';
                btnToggleControls.textContent = 'Hide Controls';
            } else {
                mainControlsPanel.style.bottom = '-200px';
                mainControlsPanel.style.opacity = '0';
                mainControlsPanel.style.pointerEvents = 'none';
                btnToggleControls.textContent = 'Show Controls';
            }
        });
    }

    const angleControl = document.getElementById('angleControl');
    const angleSlider2D = document.getElementById('angleSlider2D');
    const angleLabel = document.getElementById('angleLabel');
    const orientationSelect = document.getElementById('orientationSelect');
    const elevationControl = document.getElementById('elevationControl');
    const elevationSlider2D = document.getElementById('elevationSlider2D');
    const elevationLabel = document.getElementById('elevationLabel');

    if (orientationSelect) {
        orientationSelect.addEventListener('change', (e) => {
            sliceOrientation2D = e.target.value;
            if (sliceOrientation2D === 'horizontal') {
                if (angleControl) angleControl.style.display = 'none';
                if (elevationControl) elevationControl.style.display = 'flex';
            } else {
                if (angleControl) angleControl.style.display = 'flex';
                if (elevationControl) elevationControl.style.display = 'none';
            }
            zoom2D = 1.0;
            panX2D = 0;
            panY2D = 0;
            trigger2DRender();
        });
    }

    if (elevationSlider2D) {
        elevationSlider2D.addEventListener('input', (e) => {
            sliceElevation2D = parseInt(e.target.value);
            if (elevationLabel) elevationLabel.textContent = '+' + sliceElevation2D;
            trigger2DRender();
        });
    }

    if (angleSlider2D) {
        angleSlider2D.addEventListener('input', (e) => {
            let angle0 = parseInt(e.target.value);
            let angle1 = angle0 + 180;
            active2DSlice = `${angle0}-${angle1}`;
            if (angleLabel) angleLabel.textContent = `${angle0}° - ${angle1}°`;
            trigger2DRender();
        });
    }

    const tempThresholdInput = document.getElementById('tempThresholdInput');
    if (tempThresholdInput) {
        tempThresholdInput.addEventListener('input', (e) => {
            let val = parseInt(e.target.value);
            if (!isNaN(val) && val >= 0) {
                isothermThreshold = val;
                trigger2DRender();
            }
        });
    }

    const chkHeatmap = document.getElementById('showHeatmap2D');
    if (chkHeatmap) {
        chkHeatmap.addEventListener('change', (e) => {
            showHeatmap2D = e.target.checked;
            trigger2DRender();
        });
    }
    const chkNodes = document.getElementById('showNodes2D');
    if (chkNodes) {
        chkNodes.addEventListener('change', (e) => {
            showNodes2D = e.target.checked;
            trigger2DRender();
        });
    }
    const chkOther = document.getElementById('showOtherIsotherms');
    if (chkOther) {
        chkOther.addEventListener('change', (e) => {
            showOtherIsotherms = e.target.checked;
            trigger2DRender();
        });
    }
    const chkProfile = document.getElementById('showOriginalProfile');
    if (chkProfile) {
        chkProfile.addEventListener('change', (e) => {
            showOriginalProfile = e.target.checked;
            trigger2DRender();
        });
    }

    const resetView2DBtn = document.getElementById('resetView2DBtn');
    if (resetView2DBtn) {
        resetView2DBtn.addEventListener('click', () => {
            zoom2D = 1.0;
            panX2D = 0;
            panY2D = 0;
            trigger2DRender();
        });
    }
}

async function loadData() {
    try {
        const [profileResponse, csvResponse, tempResponse] = await Promise.all([
            fetch('./profile.json'),
            fetch('./thermocouples.csv'),
            fetch('./temperatures.json')
        ]);

        globalProfileData = await profileResponse.json();
        temperatureData = await tempResponse.json();

        // Process dates
        dates = Object.keys(temperatureData).sort((a, b) => {
            // Parse DD-MM-YYYY
            const da = a.split('-').reverse().join('-');
            const db = b.split('-').reverse().join('-');
            return new Date(da) - new Date(db);
        });

        initSlider();
        const csvText = await csvResponse.text();

        createFurnaceMesh(globalProfileData);
        processCSV(csvText);

        // Pre-compute weights for IDW optimization
        precomputeIDW();

        // Initialize 2D grid
        initializeGrid();

    } catch (error) {
        console.error('Error loading data:', error);
        alert('Error loading data. Check console for details.');
    }
}

function createFurnaceMesh(profilePoints) {
    // profilePoints is array of {z, r}, sorted by z (usually).
    // Ensure sorted by z
    profilePoints.sort((a, b) => a.z - b.z);

    // --- Outer Wall (Shell) ---
    const pointsOuter = [];
    // --- Inner Wall (Refractory) ---
    const pointsInner = [];

    const thickness = 500; // Gap between inner and outer wall

    for (let point of profilePoints) {
        if (isCroppedMode && point.z > 6637) continue; // Cut off outer shell entirely above 6637
        pointsOuter.push(new THREE.Vector2(point.r, point.z));
        // Ensure inner radius doesn't go negative
        pointsInner.push(new THREE.Vector2(Math.max(0, point.r - thickness), point.z));
    }

    const segments = 64;

    // 1. Outer Shell Mesh materials
    // Realistic Material (Transparent Glass/Metal)
    materialRealistic = new THREE.MeshPhysicalMaterial({
        color: 0xAACCFF,
        metalness: 0.1,
        roughness: 0.1,
        transmission: 0.2,
        opacity: 0.3,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        vertexColors: false // Disable vertex colors for realistic mode
    });

    // Heatmap Material (Opaque Glowing Gradient)
    materialHeatmap = new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.DoubleSide
    });

    const geometryOuter = new THREE.LatheGeometry(pointsOuter, segments);

    // Choose initial material
    meshOuter = new THREE.Mesh(geometryOuter, isHeatmapMode ? materialHeatmap : materialRealistic);

    // Initialize colors to white (or default)
    const count = geometryOuter.attributes.position.count;
    geometryOuter.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const colors = geometryOuter.attributes.color;
    for (let i = 0; i < count; i++) {
        colors.setXYZ(i, 0.6, 0.8, 1.0);
    }

    meshOuter.castShadow = true;
    scene.add(meshOuter);

    // 2. Inner Lining Mesh
    const geometryInner = new THREE.LatheGeometry(pointsInner, segments);
    const materialInner = new THREE.MeshStandardMaterial({
        color: 0xCC5544,    // Reddish/Orange for refractory/heat
        roughness: 0.7,
        metalness: 0.2,
        opacity: 0.5,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false
    });

    meshInner = new THREE.Mesh(geometryInner, materialInner);
    meshInner.visible = !isHeatmapMode; // Hide in heatmap mode
    scene.add(meshInner);

    // Add wireframe to outer shell for definition
    wireframe = new THREE.LineSegments(
        new THREE.WireframeGeometry(geometryOuter),
        new THREE.LineBasicMaterial({ color: 0x88CCFF, opacity: 0.3, transparent: true })
    );
    wireframe.visible = !isHeatmapMode; // Hide in heatmap mode
    scene.add(wireframe);

    // 3. Bottom Layer Gradient Planes
    const targetLayers = [4727, 5177, 6177];
    for (let z of targetLayers) {
        if (isCroppedMode && z > 6637) continue;

        let r = 5000;
        for (let i = 0; i < profilePoints.length - 1; i++) {
            const p1 = profilePoints[i];
            const p2 = profilePoints[i + 1];
            if (p1.z <= z && p2.z >= z) {
                const t = (z - p1.z) / (p2.z - p1.z);
                r = p1.r + t * (p2.r - p1.r);
                break;
            } else if (p1.z === z) {
                r = p1.r;
                break;
            }
        }

        // Ensure radius is valid, subtract thickness to fit inside outer wall roughly
        r = Math.max(1, r - (thickness / 2));

        // Use more segments for a smoother heatmap
        const geo = new THREE.CircleGeometry(r, 64);
        geo.rotateX(-Math.PI / 2); // Lay flat
        geo.translate(0, z, 0);

        const count = geo.attributes.position.count;
        geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
        const colors = geo.attributes.color;
        for (let i = 0; i < count; i++) colors.setXYZ(i, 0.6, 0.8, 1.0);

        const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.visible = isHeatmapMode;
        scene.add(mesh);
        bottomPlanes.push(mesh);
    }
}


function processCSV(csvText) {
    const lines = csvText.split('\n');

    // Skip header (line 0) and iterate
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // format: FURNACE TC postion,no.,TC,X,Y,Z
        const parts = line.split(',');
        if (parts.length < 6) continue;

        const posName = parts[0];
        const no = parts[1];
        const tcId = parts[2];
        const x = parseFloat(parts[3]);
        const y = parseFloat(parts[4]);
        const z = parseFloat(parts[5]); // Height

        if (isNaN(x) || isNaN(y) || isNaN(z)) continue;

        // In Three.js: X->X, Y->Z, Z->Y (Height)
        const vec = new THREE.Vector3(x, z, y);

        // Store for IDW
        thermocouplePositions.push({ id: parts[2], pos: vec.clone() });

        // Represent TC as a small cylinder pointing outwards

        // Represent TC as a small cylinder pointing outwards
        // Direction from center (0, z, 0) to point (x, z, y)
        // Vector on horizontal plane:
        const normal = new THREE.Vector3(x, 0, y).normalize();

        // Color based on position name
        const color = getColorForPosition(posName);

        // Group for TC
        const tcGroup = new THREE.Group();
        tcGroup.position.copy(vec);

        // 1. The probe (cylinder)
        // Rotate cylinder to align with normal
        // Cylinder default is along Y axis. We want it along 'normal'.
        // Use fit-to-orientation logic
        const dummy = new THREE.Object3D();
        dummy.lookAt(normal); // Z axis points to normal

        // Create Mesh
        const probeLen = 400; // Enlarged from 200
        const probeGeo = new THREE.CylinderGeometry(30, 30, probeLen, 8); // Thicker
        const probeMat = new THREE.MeshStandardMaterial({ color: 0x444444 });
        const probe = new THREE.Mesh(probeGeo, probeMat);

        // Rotate probe so its Y axis matches our Z axis (lookAt result)
        probe.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
        // Move it slightly out so it sticks out
        probe.position.add(normal.clone().multiplyScalar(probeLen / 2));

        tcGroup.add(probe);

        // 2. The tip/sensor head (sphere or box)
        const headGeo = new THREE.SphereGeometry(150, 16, 16); // Enlarged Sphere
        // Emissive material for "bright" look
        const headMat = new THREE.MeshStandardMaterial({
            color: color,
            emissive: color,
            emissiveIntensity: 0.8
        });
        const head = new THREE.Mesh(headGeo, headMat);
        head.position.copy(probe.position).add(normal.clone().multiplyScalar(probeLen / 2));

        // Add UserData for interaction
        head.userData = { id: tcId, position: posName, no: no, rawZ: z };

        // Store reference for updates. ID in CSV parts[2] is string "001", etc.
        // process_temperatures.py converts Sl No to int then string "1".
        // Normalize "001" -> "1"
        const normalizedId = parseInt(tcId).toString();
        thermocoupleMeshes[normalizedId] = head;

        tcGroup.add(head);
        scene.add(tcGroup);
    }
}

function getColorForPosition(posName) {
    // Generate a consistent BRIGHT color
    // Use HSL: hue = based on hash, saturation = 100%, lightness = 50%
    let hash = 0;
    for (let i = 0; i < posName.length; i++) {
        hash = posName.charCodeAt(i) + ((hash << 5) - hash);
    }

    const hue = Math.abs(hash % 360) / 360;
    const color = new THREE.Color().setHSL(hue, 1.0, 0.5);
    return color;
}

function initSlider() {
    const slider = document.getElementById('dateSlider');
    const label = document.getElementById('dateLabel');

    if (dates.length === 0) {
        label.textContent = "No Data Available";
        return;
    }

    slider.min = 0;
    slider.max = dates.length - 1;
    slider.value = 0;
    slider.disabled = false;

    // Update on change
    slider.addEventListener('input', (e) => {
        const index = parseInt(e.target.value);
        const date = dates[index];
        label.textContent = `Date: ${date}`;
        updateHeatmap(date);
    });

    // Initial set
    const initialDate = dates[0];
    label.textContent = `Date: ${initialDate}`;

    // Toggle Button
    const btn = document.getElementById('toggleBtn');

    // Set initial button state based on default mode
    btn.textContent = isHeatmapMode ? "Switch to Points View" : "Switch to Heatmap View";
    if (isHeatmapMode) btn.classList.add('active');

    btn.addEventListener('click', () => {
        isHeatmapMode = !isHeatmapMode;
        btn.textContent = isHeatmapMode ? "Switch to Points View" : "Switch to Heatmap View";
        btn.classList.toggle('active', isHeatmapMode);

        // Trigger update to apply mode
        const date = dates[parseInt(slider.value)];
        updateHeatmap(date);
    });

    // Height Toggle Button
    const heightBtn = document.getElementById('heightToggleBtn');
    if (heightBtn) {
        heightBtn.textContent = isCroppedMode ? "Switch to Full Height" : "Switch to Cropped Height";
        heightBtn.addEventListener('click', () => {
            isCroppedMode = !isCroppedMode;
            heightBtn.textContent = isCroppedMode ? "Switch to Full Height" : "Switch to Cropped Height";

            // Rebuild furnace mesh
            if (meshOuter) { scene.remove(meshOuter); meshOuter.geometry.dispose(); }
            if (meshInner) { scene.remove(meshInner); meshInner.geometry.dispose(); meshInner.material.dispose(); }
            if (wireframe) { scene.remove(wireframe); wireframe.geometry.dispose(); wireframe.material.dispose(); }

            bottomPlanes.forEach(p => {
                scene.remove(p);
                p.geometry.dispose();
                p.material.dispose();
            });
            bottomPlanes = [];

            createFurnaceMesh(globalProfileData);
            precomputeIDW();

            // Adjust camera
            if (isCroppedMode) {
                controls.target.set(0, 3000, 0);
            } else {
                controls.target.set(0, 7000, 0);
            }

            const date = dates[parseInt(slider.value)];
            updateHeatmap(date);
        });
    }

    // Isolate Planes Button
    const isolateBtn = document.getElementById('isolatePlanesBtn');
    if (isolateBtn) {
        isolateBtn.addEventListener('click', () => {
            isIsolatedMode = !isIsolatedMode;
            isolateBtn.textContent = isIsolatedMode ? "Restore Furnace Shell" : "Isolate Stacked Planes";

            if (isIsolatedMode) {
                isolateBtn.style.background = "#ff00ff";
                isolateBtn.style.color = "#000";
            } else {
                isolateBtn.style.background = "#600060";
                isolateBtn.style.color = "#fff";
            }

            const date = dates[parseInt(slider.value)];
            updateHeatmap(date);
        });
    }

    updateHeatmap(initialDate);
}

function updateHeatmap(date) {
    const dailyTemps = temperatureData[date];
    if (!dailyTemps) return;

    // Color scale: Blue (Low) -> Green (Mid) -> Red (High)
    // Low: 100, High: 1200
    const minTemp = 100;
    const maxTemp = 1200;

    // 1. Update Points (Always, or hide?)
    // User said "keep previous", so keep points visible even in heatmap mode

    for (let id in thermocoupleMeshes) {
        const mesh = thermocoupleMeshes[id];
        const temp = dailyTemps[id];

        if (isCroppedMode && mesh.userData.rawZ > 6637) {
            mesh.visible = false;
            mesh.userData.temp = undefined;
            continue;
        }

        if (temp !== undefined) {
            // Custom Heatmap Color Logic
            // Blue (<250) -> Yellow (250) -> Red (450) -> Dark Brown (>450)
            const color = new THREE.Color();
            if (temp < 250) {
                // Gradient of blue down to ~50C
                const factor = Math.max(0, (temp - 50) / 200);
                color.lerpColors(new THREE.Color(0x000044), new THREE.Color(0x0088ff), factor);
            } else if (temp < 450) {
                // Yellow to Red transition
                const factor = (temp - 250) / 200;
                color.lerpColors(new THREE.Color(0xffff00), new THREE.Color(0xff0000), factor);
            } else {
                // Red to Dark Brown transition
                // Cap mapping to 1000C for maximum dark brown point
                const factor = Math.min(1, (temp - 450) / 550);
                color.lerpColors(new THREE.Color(0xff0000), new THREE.Color(0x3e1700), factor);
            }

            mesh.material.color.copy(color);
            mesh.material.emissive.copy(color);
            mesh.visible = true; // Always visible

            mesh.userData.temp = temp;
        } else {
            // No data -> Grey
            mesh.material.color.setHex(0x333333);
            mesh.material.emissive.setHex(0x000000);
            mesh.userData.temp = undefined;
        }
    }

    // 2. Update Shell (Heatmap Mode)
    if (!meshOuter) return;

    if (isIsolatedMode) {
        // Completely hide the shell and inner lining when Isolated
        meshOuter.visible = false;
        if (meshInner) meshInner.visible = false;
        if (wireframe) wireframe.visible = false;
        bottomPlanes.forEach(p => p.visible = true);

        // Still calculate colors in case we want to show it again, but planes get updated
        interpolateTemperatures(dailyTemps, minTemp, maxTemp);
    } else {
        meshOuter.visible = true;
        if (isHeatmapMode) {
            // Switch to Heatmap Material
            meshOuter.material = materialHeatmap;
            interpolateTemperatures(dailyTemps, minTemp, maxTemp);

            // Hide other elements for clean look
            if (meshInner) meshInner.visible = false;
            if (wireframe) wireframe.visible = false;
            bottomPlanes.forEach(p => p.visible = true);

        } else {
            // Switch to Realistic Material
            meshOuter.material = materialRealistic;

            // Show components
            if (meshInner) meshInner.visible = true;
            if (wireframe) wireframe.visible = true;
            bottomPlanes.forEach(p => p.visible = false);
        }
    }

    // 3. Update High Temp Table
    const listBody = document.getElementById('highTempList');
    const countDiv = document.getElementById('highTempCount');

    if (listBody && countDiv) {
        listBody.innerHTML = '';
        let highTempTCs = [];

        // We can't iterate thermocoupleMeshes directly efficiently if we want temp, 
        // but we have dailyTemps map.
        // Actually thermocoupleMeshes keys are normalized IDs. dailyTemps keys are also normalized IDs.

        for (let id in dailyTemps) {
            const mesh = thermocoupleMeshes[id];
            if (!mesh || (isCroppedMode && mesh.userData.rawZ > 6637)) continue;

            const temp = dailyTemps[id];
            if (temp > 1150) {
                // Find mesh to get metadata
                highTempTCs.push({
                    id: mesh.userData.id, // Original ID
                    pos: mesh.userData.position,
                    temp: temp
                });
            }
        }

        // Sort by temp descending
        highTempTCs.sort((a, b) => b.temp - a.temp);

        countDiv.textContent = `Count: ${highTempTCs.length}`;

        if (highTempTCs.length === 0) {
            const row = document.createElement('tr');
            row.innerHTML = '<td colspan="3" style="text-align:center; padding: 10px; color: #888;">No TCs > 1150°C</td>';
            listBody.appendChild(row);
        } else {
            highTempTCs.forEach(tc => {
                const row = document.createElement('tr');
                row.style.borderBottom = '1px solid #444';
                row.innerHTML = `
                    <td style="padding: 4px;">${tc.id}</td>
                    <td style="padding: 4px;">${tc.pos}</td>
                    <td style="text-align: right; padding: 4px; color: #ff5555; font-weight: bold;">
                        ${Math.round(tc.temp)}°C
                    </td>
                `;
                listBody.appendChild(row);
            });
        }
    }

    // Update the 2D View if it is active
    if (!is3DMode) {
        trigger2DRender();
    }
}

function precomputeIDW() {
    if (!meshOuter || thermocouplePositions.length === 0) return;

    function computeForGeo(geometry) {
        const positions = geometry.attributes.position;
        const weights = new Float32Array(positions.count * thermocouplePositions.length);
        const p = 2.0; // Power parameter
        for (let i = 0; i < positions.count; i++) {
            const vx = positions.getX(i);
            const vy = positions.getY(i);
            const vz = positions.getZ(i);
            const vPos = new THREE.Vector3(vx, vy, vz);

            for (let j = 0; j < thermocouplePositions.length; j++) {
                const tc = thermocouplePositions[j];
                const distSq = vPos.distanceToSquared(tc.pos);
                // Avoid division by zero
                const dist = Math.sqrt(distSq);
                let w = 0;
                if (dist < 0.1) w = 1e9; // extremely large weight for exact match
                else w = 1.0 / Math.pow(dist, p);

                weights[i * thermocouplePositions.length + j] = w;
            }
        }
        return weights;
    }

    console.log("Pre-computing IDW weights for all geometries...");
    idwWeightsOuter = computeForGeo(meshOuter.geometry);
    bottomPlaneWeights = bottomPlanes.map(plane => computeForGeo(plane.geometry));
    console.log("IDW Pre-computation complete.");
}

function interpolateTemperatures(dailyTemps, minTemp, maxTemp) {
    if (idwWeightsOuter.length === 0) return;

    const numTCs = thermocouplePositions.length;

    // Create map of active TCs to avoid parsing IDs in the loop
    // tcIndex -> temp (or undefined)
    const activeTemps = new Float32Array(numTCs);
    const activeFlags = new Uint8Array(numTCs); // 1 if active, 0 if not

    for (let j = 0; j < numTCs; j++) {
        const tc = thermocouplePositions[j];
        if (isCroppedMode && tc.pos.y > 6637) {
            activeFlags[j] = 0;
            continue;
        }

        const rawId = parseInt(tc.id).toString();
        const t = dailyTemps[rawId];
        if (t !== undefined) {
            activeTemps[j] = t;
            activeFlags[j] = 1;
        } else {
            activeFlags[j] = 0;
        }
    }

    function applyToMesh(mesh, weights) {
        if (!mesh || !weights) return;
        const positions = mesh.geometry.attributes.position;
        const colors = mesh.geometry.attributes.color;

        for (let i = 0; i < positions.count; i++) {
            let sumWeights = 0;
            let weightedTemp = 0;
            const offset = i * numTCs;

            for (let j = 0; j < numTCs; j++) {
                if (activeFlags[j] === 0) continue; // Skip missing data

                const w = weights[offset + j];
                weightedTemp += activeTemps[j] * w;
                sumWeights += w;
            }

            let finalTemp = minTemp;
            if (sumWeights > 0) {
                finalTemp = weightedTemp / sumWeights;
            }

            // Custom Gradient Logic matching the spheres
            const color = new THREE.Color();
            if (finalTemp < 250) {
                const factor = Math.max(0, (finalTemp - 50) / 200);
                color.lerpColors(new THREE.Color(0x000044), new THREE.Color(0x0088ff), factor);
            } else if (finalTemp < 450) {
                const factor = (finalTemp - 250) / 200;
                color.lerpColors(new THREE.Color(0xffff00), new THREE.Color(0xff0000), factor);
            } else {
                const factor = Math.min(1, (finalTemp - 450) / 550);
                color.lerpColors(new THREE.Color(0xff0000), new THREE.Color(0x3e1700), factor);
            }

            colors.setXYZ(i, color.r, color.g, color.b);
        }
        colors.needsUpdate = true;
    }

    applyToMesh(meshOuter, idwWeightsOuter);
    for (let i = 0; i < bottomPlanes.length; i++) {
        applyToMesh(bottomPlanes[i], bottomPlaneWeights[i]);
    }
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function onPointerMove(event) {
    pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;

    raycaster.setFromCamera(pointer, camera);
    const intersects = raycaster.intersectObjects(scene.children, true); // Recursive

    if (intersects.length > 0) {
        // Find first with userData
        const target = intersects.find(i => i.object.userData && i.object.userData.id);

        if (target) {
            const data = target.object.userData;
            tooltip.style.display = 'block';
            tooltip.style.left = event.clientX + 10 + 'px';
            tooltip.style.top = event.clientY + 10 + 'px';
            const tempStr = data.temp !== undefined ? `${Math.round(data.temp)}°C` : 'N/A';
            tooltip.innerHTML = `
                <strong>${data.id}</strong><br>
                Pos: ${data.position}<br>
                Height: ${data.rawZ}<br>
                Temp: ${tempStr}
            `;
            document.body.style.cursor = 'pointer';
        } else {
            tooltip.style.display = 'none';
            document.body.style.cursor = 'default';
        }
    } else {
        tooltip.style.display = 'none';
        document.body.style.cursor = 'default';
    }
}

function exportGLTF() {
    const exporter = new GLTFExporter();
    
    const exportObjects = [];
    if (meshOuter && meshOuter.visible) exportObjects.push(meshOuter);
    if (meshInner && meshInner.visible) exportObjects.push(meshInner);
    
    for (let id in thermocoupleMeshes) {
        if (thermocoupleMeshes[id].parent.visible) {
            exportObjects.push(thermocoupleMeshes[id].parent);
        }
    }
    
    if (bottomPlanes && bottomPlanes.length > 0) {
        bottomPlanes.forEach(p => {
            if (p.visible) exportObjects.push(p);
        });
    }
    
    exporter.parse(
        exportObjects,
        function (gltf) {
            const blob = new Blob([gltf], { type: 'application/octet-stream' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.style.display = 'none';
            link.href = url;
            link.download = 'blast_furnace_model.glb';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        },
        function (error) {
            console.error('An error happened during GLTF export:', error);
            alert('Failed to export 3D model.');
        },
        { binary: true } // Export as GLB
    );
}

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}

function createTextSprite(text, position, color = "white", fontSize = 40) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = color;
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 64);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const spriteMaterial = new THREE.SpriteMaterial({ map: texture, depthTest: false });
    const sprite = new THREE.Sprite(spriteMaterial);

    sprite.position.copy(position);
    sprite.scale.set(1500, 750, 1);
    sprite.renderOrder = 999; // Render on top of grid lines

    return sprite;
}

// ==========================================
// 2D ISOTHERM VIEW FUNCTIONS
// ==========================================

function initializeGrid() {
    gridValues = [];
    gridR = [];
    gridZ = [];
    
    const localMinZ = (sliceOrientation2D === 'horizontal') ? -7600 : 3500;
    const localMaxZ = (sliceOrientation2D === 'horizontal') ? 7600 : 14100;
    
    const rStep = (maxR - minR) / (gridCols - 1);
    const zStep = (localMaxZ - localMinZ) / (gridRows - 1);
    
    for (let c = 0; c < gridCols; c++) {
        gridR.push(minR + c * rStep);
    }
    for (let r = 0; r < gridRows; r++) {
        gridZ.push(localMinZ + r * zStep);
    }
    
    for (let c = 0; c < gridCols; c++) {
        gridValues.push(new Float32Array(gridRows));
    }
}

function projectThermocouples(sliceAngleStr) {
    projectedTCs = [];
    
    const slider = document.getElementById('dateSlider');
    const date = dates[parseInt(slider.value)];
    const dailyTemps = temperatureData[date] || {};
    
    if (sliceOrientation2D === 'horizontal') {
        const targetZ = sliceElevation2D;
        for (let tc of thermocouplePositions) {
            const z = tc.pos.y; // Height
            if (Math.abs(z - targetZ) <= 1000) { // +/- 1000mm tolerance
                const normalizedId = parseInt(tc.id).toString();
                const temp = dailyTemps[normalizedId];
                const mesh = thermocoupleMeshes[normalizedId];
                
                projectedTCs.push({
                    id: tc.id,
                    no: mesh ? mesh.userData.no : "",
                    r: tc.pos.x, // Map X to canvas X (using R array)
                    z: tc.pos.z, // Map Y to canvas Y (using Z array)
                    temp: temp,
                    posName: mesh ? mesh.userData.position : "",
                    trueZ: z
                });
            }
        }
    } else {
        const parts = sliceAngleStr.split('-');
        const targetAngle0 = parseFloat(parts[0]);
        const targetAngle1 = parseFloat(parts[1]);
        
        for (let tc of thermocouplePositions) {
            const x = tc.pos.x;
            const y = tc.pos.z; 
            const z = tc.pos.y; 
            
            const r = Math.sqrt(x*x + y*y);
            let angleRad = Math.atan2(y, x);
            let angleDeg = angleRad * (180 / Math.PI);
            if (angleDeg < 0) angleDeg += 360;
            
            let isMatch = false;
            let projectedR = 0;
            
            if (r < 10) {
                isMatch = true;
                projectedR = 0;
            } else {
                const diff0 = Math.min(Math.abs(angleDeg - targetAngle0), 360 - Math.abs(angleDeg - targetAngle0));
                const diff1 = Math.min(Math.abs(angleDeg - targetAngle1), 360 - Math.abs(angleDeg - targetAngle1));
                
                const tolerance = 10.0;
                
                if (diff0 <= tolerance) {
                    isMatch = true;
                    projectedR = r;
                } else if (diff1 <= tolerance) {
                    isMatch = true;
                    projectedR = -r;
                }
            }
            
            if (isMatch) {
                const normalizedId = parseInt(tc.id).toString();
                const temp = dailyTemps[normalizedId];
                const mesh = thermocoupleMeshes[normalizedId];
                
                projectedTCs.push({
                    id: tc.id,
                    no: mesh ? mesh.userData.no : "",
                    r: projectedR,
                    z: z,
                    temp: temp,
                    posName: mesh ? mesh.userData.position : "",
                    angleDeg: angleDeg
                });
            }
        }
    }
}

function interpolateGrid() {
    const activeTCs = projectedTCs.filter(tc => tc.temp !== undefined);
    
    if (activeTCs.length === 0) {
        for (let c = 0; c < gridCols; c++) {
            gridValues[c].fill(0);
        }
        return;
    }
    
    const power = 2.0;
    
    for (let c = 0; c < gridCols; c++) {
        const r = gridR[c];
        for (let rIdx = 0; rIdx < gridRows; rIdx++) {
            const z = gridZ[rIdx];
            
            let sumWeights = 0;
            let sumWeightedTemp = 0;
            let exactMatchTemp = null;
            
            for (let tc of activeTCs) {
                const dr = r - tc.r;
                const dz = z - tc.z;
                const distSq = dr*dr + dz*dz;
                const dist = Math.sqrt(distSq);
                
                if (dist < 50.0) {
                    exactMatchTemp = tc.temp;
                    break;
                }
                
                const w = 1.0 / Math.pow(dist, power);
                sumWeightedTemp += tc.temp * w;
                sumWeights += w;
            }
            
            if (exactMatchTemp !== null) {
                gridValues[c][rIdx] = exactMatchTemp;
            } else if (sumWeights > 0) {
                gridValues[c][rIdx] = sumWeightedTemp / sumWeights;
            } else {
                gridValues[c][rIdx] = 0;
            }
        }
    }
}

function getHeatmapColor(temp) {
    let r = 0, g = 0, b = 0;
    
    if (temp < 250) {
        const factor = Math.max(0, (temp - 50) / 200);
        r = 0;
        g = Math.round(136 * factor);
        b = Math.round(68 + (255 - 68) * factor);
    } else if (temp < 450) {
        const factor = (temp - 250) / 200;
        r = 255;
        g = Math.round(255 * (1 - factor));
        b = 0;
    } else {
        const factor = Math.min(1, (temp - 450) / 550);
        r = Math.round(255 + (62 - 255) * factor);
        g = Math.round(23 * factor);
        b = 0;
    }
    return { r, g, b };
}

function renderHeatmapToOffscreen() {
    if (!offscreenCanvas) {
        offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = gridCols;
        offscreenCanvas.height = gridRows;
        offscreenCtx = offscreenCanvas.getContext('2d');
    }
    
    const imgData = offscreenCtx.createImageData(gridCols, gridRows);
    const data = imgData.data;
    
    for (let col = 0; col < gridCols; col++) {
        for (let row = 0; row < gridRows; row++) {
            const temp = gridValues[col][row];
            const color = getHeatmapColor(temp);
            
            const imgX = col;
            const imgY = gridRows - 1 - row;
            const pixelIdx = (imgY * gridCols + imgX) * 4;
            
            data[pixelIdx] = color.r;
            data[pixelIdx + 1] = color.g;
            data[pixelIdx + 2] = color.b;
            data[pixelIdx + 3] = 255;
        }
    }
    
    offscreenCtx.putImageData(imgData, 0, 0);
}

function updateScale() {
    const width = canvas2D.width;
    const height = canvas2D.height;
    
    const localMinZ = (sliceOrientation2D === 'horizontal') ? -7600 : 3500;
    const localMaxZ = (sliceOrientation2D === 'horizontal') ? 7600 : 14100;
    
    const physicalWidth = maxR - minR;
    const physicalHeight = localMaxZ - localMinZ;
    
    const margin = 60;
    const scaleX = (width - margin * 2) / physicalWidth;
    const scaleY = (height - margin * 2) / physicalHeight;
    const baseScale = Math.min(scaleX, scaleY);
    
    scale2D = baseScale * zoom2D;
    
    offsetX2D = (width - physicalWidth * scale2D) / 2 - minR * scale2D + panX2D;
    offsetY2D = height - (height - physicalHeight * scale2D) / 2 + localMinZ * scale2D + panY2D;
}

function rToX(r) {
    return offsetX2D + r * scale2D;
}

function zToY(z) {
    return offsetY2D - z * scale2D;
}

function xToR(x) {
    return (x - offsetX2D) / scale2D;
}

function yToZ(y) {
    return (offsetY2D - y) / scale2D;
}

function isInsideRefractory(r, z) {
    if (sliceOrientation2D === 'horizontal') {
        const dist = Math.sqrt(r*r + z*z);
        const maxDist = (sliceElevation2D < 7100) ? 7320 : 6600;
        return dist <= maxDist;
    }
    if (z < 3946 || z > 13900) return false;
    const absR = Math.abs(r);
    if (absR > 7320) return false;
    
    if (z >= 7100) {
        return absR >= 6600;
    } else {
        return true;
    }
}

function clipToRefractory(ctx) {
    ctx.beginPath();
    if (sliceOrientation2D === 'horizontal') {
        const maxDist = (sliceElevation2D < 7100) ? 7320 : 6600;
        ctx.arc(rToX(0), zToY(0), maxDist * scale2D, 0, Math.PI * 2);
    } else {
        ctx.moveTo(rToX(-7320), zToY(13900));
        ctx.lineTo(rToX(-7320), zToY(3946));
        ctx.lineTo(rToX(7320), zToY(3946));
        ctx.lineTo(rToX(7320), zToY(13900));
        ctx.lineTo(rToX(6600), zToY(13900));
        ctx.lineTo(rToX(6600), zToY(7100));
        ctx.lineTo(rToX(-6600), zToY(7100));
        ctx.lineTo(rToX(-6600), zToY(13900));
    }
    ctx.closePath();
    ctx.clip();
}

function getEdgePoint(edgeIndex, r0, r1, z0, z1, v0, v1, v2, v3, Tiso) {
    let t, r_val, z_val;
    switch(edgeIndex) {
        case 0: // bottom
            t = (Tiso - v0) / (v1 - v0);
            r_val = r0 + t * (r1 - r0);
            z_val = z0;
            break;
        case 1: // right
            t = (Tiso - v1) / (v2 - v1);
            r_val = r1;
            z_val = z0 + t * (z1 - z0);
            break;
        case 2: // top
            t = (Tiso - v2) / (v3 - v2);
            r_val = r1 + t * (r0 - r1);
            z_val = z1;
            break;
        case 3: // left
            t = (Tiso - v3) / (v0 - v3);
            r_val = r0;
            z_val = z1 + t * (z0 - z1);
            break;
    }
    return { r: r_val, z: z_val };
}

function drawSingleIsotherm(tempValue, color, lineWidth) {
    const segments = [];
    
    for (let c = 0; c < gridCols - 1; c++) {
        const r0 = gridR[c];
        const r1 = gridR[c+1];
        
        for (let rIdx = 0; rIdx < gridRows - 1; rIdx++) {
            const z0 = gridZ[rIdx];
            const z1 = gridZ[rIdx+1];
            
            const v0 = gridValues[c][rIdx];
            const v1 = gridValues[c+1][rIdx];
            const v2 = gridValues[c+1][rIdx+1];
            const v3 = gridValues[c][rIdx+1];
            
            const cellCenterR = (r0 + r1) / 2;
            const cellCenterZ = (z0 + z1) / 2;
            if (!isInsideRefractory(cellCenterR, cellCenterZ)) {
                continue;
            }
            
            let code = 0;
            if (v0 >= tempValue) code |= 1;
            if (v1 >= tempValue) code |= 2;
            if (v2 >= tempValue) code |= 4;
            if (v3 >= tempValue) code |= 8;
            
            const cases = {
                1: [[0, 3]],
                2: [[0, 1]],
                3: [[1, 3]],
                4: [[1, 2]],
                5: [[0, 3], [1, 2]],
                6: [[0, 2]],
                7: [[2, 3]],
                8: [[2, 3]],
                9: [[0, 2]],
                10: [[0, 1], [2, 3]],
                11: [[1, 2]],
                12: [[1, 3]],
                13: [[0, 1]],
                14: [[0, 3]]
            };
            
            const conns = cases[code];
            if (conns) {
                for (let conn of conns) {
                    const p1 = getEdgePoint(conn[0], r0, r1, z0, z1, v0, v1, v2, v3, tempValue);
                    const p2 = getEdgePoint(conn[1], r0, r1, z0, z1, v0, v1, v2, v3, tempValue);
                    segments.push({ p1, p2 });
                }
            }
        }
    }
    
    ctx2D.save();
    clipToRefractory(ctx2D);
    
    ctx2D.strokeStyle = color;
    ctx2D.lineWidth = lineWidth;
    ctx2D.beginPath();
    for (let seg of segments) {
        ctx2D.moveTo(rToX(seg.p1.r), zToY(seg.p1.z));
        ctx2D.lineTo(rToX(seg.p2.r), zToY(seg.p2.z));
    }
    ctx2D.stroke();
    
    if (segments.length > 8) {
        const midIdx = Math.floor(segments.length / 2);
        const midSeg = segments[midIdx];
        const labelX = rToX((midSeg.p1.r + midSeg.p2.r) / 2);
        const labelY = zToY((midSeg.p1.z + midSeg.p2.z) / 2);
        
        ctx2D.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx2D.font = 'bold 9px sans-serif';
        const labelText = tempValue + '°C';
        const textWidth = ctx2D.measureText(labelText).width;
        
        ctx2D.fillRect(labelX - textWidth/2 - 3, labelY - 6, textWidth + 6, 12);
        ctx2D.fillStyle = color;
        ctx2D.textAlign = 'center';
        ctx2D.textBaseline = 'middle';
        ctx2D.fillText(labelText, labelX, labelY);
    }
    
    ctx2D.restore();
}

function draw2DIsotherm() {
    if (!canvas2D || !ctx2D) return;
    
    ctx2D.fillStyle = '#ffffff';
    ctx2D.fillRect(0, 0, canvas2D.width, canvas2D.height);
    
    updateScale();
    
    if (showHeatmap2D) {
        renderHeatmapToOffscreen();
        
        ctx2D.save();
        clipToRefractory(ctx2D);
        
        const localMinZ = (sliceOrientation2D === 'horizontal') ? -7600 : 3500;
        const localMaxZ = (sliceOrientation2D === 'horizontal') ? 7600 : 14100;

        const x0 = rToX(minR);
        const y0 = zToY(localMaxZ);
        const w = rToX(maxR) - x0;
        const h = zToY(localMinZ) - y0;
        
        ctx2D.imageSmoothingEnabled = true;
        ctx2D.drawImage(offscreenCanvas, x0, y0, w, h);
        ctx2D.restore();
    }
    
    if (sliceOrientation2D === 'horizontal') {
        const maxDist = (sliceElevation2D < 7100) ? 7320 : 6600;
        ctx2D.fillStyle = 'rgba(255, 240, 240, 0.85)';
        ctx2D.beginPath();
        ctx2D.arc(rToX(0), zToY(0), maxDist * scale2D, 0, Math.PI * 2);
        ctx2D.fill();
        ctx2D.strokeStyle = '#eebbbb';
        ctx2D.lineWidth = 2;
        ctx2D.stroke();

        ctx2D.fillStyle = '#b74040';
        ctx2D.font = 'bold 20px sans-serif';
        ctx2D.textAlign = 'center';
        ctx2D.textBaseline = 'middle';
        ctx2D.fillText("HORIZONTAL CROSS-SECTION", rToX(0), zToY(0) - 20);
        ctx2D.font = 'bold 16px sans-serif';
        ctx2D.fillText("EL +" + sliceElevation2D, rToX(0), zToY(0) + 10);

        if (showOriginalProfile) {
            ctx2D.strokeStyle = '#cccccc';
            ctx2D.lineWidth = 10;
            ctx2D.beginPath();
            ctx2D.arc(rToX(0), zToY(0), 7400 * scale2D, 0, Math.PI * 2);
            ctx2D.stroke();

            ctx2D.strokeStyle = 'rgba(0, 0, 0, 0.2)';
            ctx2D.lineWidth = 1;
            ctx2D.beginPath();
            ctx2D.moveTo(rToX(-7500), zToY(0));
            ctx2D.lineTo(rToX(7500), zToY(0));
            ctx2D.moveTo(rToX(0), zToY(-7500));
            ctx2D.lineTo(rToX(0), zToY(7500));
            ctx2D.stroke();
            
            if (sliceElevation2D < 7100) {
                ctx2D.strokeStyle = '#ff9900';
                ctx2D.lineWidth = 1.5;
                ctx2D.setLineDash([4, 4]);
                ctx2D.beginPath();
                ctx2D.arc(rToX(0), zToY(0), 5800 * scale2D, 0, Math.PI * 2);
                ctx2D.stroke();
                ctx2D.setLineDash([]);
            }
        }
    } else {
        ctx2D.fillStyle = 'rgba(255, 240, 240, 0.85)';
        ctx2D.beginPath();
        ctx2D.moveTo(rToX(-6600), zToY(13900));
        ctx2D.lineTo(rToX(-6600), zToY(7100));
        ctx2D.lineTo(rToX(6600), zToY(7100));
        ctx2D.lineTo(rToX(6600), zToY(13900));
        ctx2D.closePath();
        ctx2D.fill();
        
        ctx2D.strokeStyle = '#eebbbb';
        ctx2D.lineWidth = 2;
        ctx2D.stroke();
        
        ctx2D.fillStyle = '#b74040';
        ctx2D.font = 'bold 20px sans-serif';
        ctx2D.textAlign = 'center';
        ctx2D.textBaseline = 'middle';
        ctx2D.fillText("HEARTH CHAMBER (LIQUID METAL)", rToX(0), zToY(10500));
        
        if (showOriginalProfile) {
            ctx2D.strokeStyle = '#cccccc';
            ctx2D.lineWidth = 10;
            ctx2D.beginPath();
            ctx2D.moveTo(rToX(-7400), zToY(13900));
            ctx2D.lineTo(rToX(-7400), zToY(3946));
            ctx2D.lineTo(rToX(7400), zToY(3946));
            ctx2D.lineTo(rToX(7400), zToY(13900));
            ctx2D.stroke();
            
            ctx2D.fillStyle = 'rgba(200, 210, 220, 0.4)';
            ctx2D.beginPath();
            ctx2D.rect(rToX(-7400), zToY(13900), 80 * scale2D, (13900 - 3946) * scale2D);
            ctx2D.rect(rToX(7320), zToY(13900), 80 * scale2D, (13900 - 3946) * scale2D);
            ctx2D.fill();
            ctx2D.strokeStyle = '#bbbbbb';
            ctx2D.lineWidth = 1;
            ctx2D.stroke();
            
            ctx2D.fillStyle = 'rgba(255, 200, 100, 0.08)';
            ctx2D.strokeStyle = '#ff9900';
            ctx2D.lineWidth = 1.5;
            ctx2D.setLineDash([4, 4]);
            ctx2D.beginPath();
            ctx2D.rect(rToX(-5800), zToY(7100), 11600 * scale2D, (7100 - 6177) * scale2D);
            ctx2D.fill();
            ctx2D.stroke();
            ctx2D.setLineDash([]);
            
            ctx2D.fillStyle = '#cc6600';
            ctx2D.font = 'bold 10px sans-serif';
            ctx2D.fillText("MULLITE CERAMIC CUP", rToX(0), zToY(6637));
            
            ctx2D.strokeStyle = 'rgba(0, 0, 0, 0.2)';
            ctx2D.lineWidth = 1;
            const dividerZ = [4160, 4727, 5177, 5677, 6177, 6637, 7100, 7550, 8450, 9350, 10400, 11600];
            for (let z of dividerZ) {
                ctx2D.beginPath();
                ctx2D.moveTo(rToX(-7320), zToY(z));
                ctx2D.lineTo(rToX(7320), zToY(z));
                ctx2D.stroke();
                
                ctx2D.fillStyle = '#777777';
                ctx2D.font = '9px monospace';
                ctx2D.textAlign = 'left';
                ctx2D.fillText(`EL. +${z}`, rToX(7450), zToY(z) + 3);
            }
            
            ctx2D.strokeStyle = 'rgba(0, 0, 0, 0.15)';
            ctx2D.setLineDash([10, 5, 2, 5]);
            ctx2D.beginPath();
            ctx2D.moveTo(rToX(0), zToY(3500));
            ctx2D.lineTo(rToX(0), zToY(13900));
            ctx2D.stroke();
            ctx2D.setLineDash([]);
            ctx2D.fillStyle = '#555555';
            ctx2D.fillText("C.L. BLAST FURNACE", rToX(0), zToY(14000));
            ctx2D.textAlign = 'center';
        }
    }
    
    drawSingleIsotherm(isothermThreshold, '#ff2222', 3);
    
    if (showOtherIsotherms) {
        const others = [200, 400, 600, 800, 1000];
        const colors = ['#0055ff', '#0099aa', '#228800', '#ccaa00', '#cc5500'];
        for (let i = 0; i < others.length; i++) {
            if (others[i] !== isothermThreshold) {
                drawSingleIsotherm(others[i], colors[i], 1.2);
            }
        }
    }
    
    if (showNodes2D) {
        for (let tc of projectedTCs) {
            const x = rToX(tc.r);
            const y = zToY(tc.z);
            
            const isHovered = (hoveredNode2D && hoveredNode2D.id === tc.id);
            const rad = isHovered ? 8 : 5;
            
            ctx2D.beginPath();
            ctx2D.arc(x, y, rad + 1.5, 0, Math.PI * 2);
            ctx2D.fillStyle = isHovered ? '#000000' : '#cccccc';
            ctx2D.fill();
            
            ctx2D.beginPath();
            ctx2D.arc(x, y, rad, 0, Math.PI * 2);
            if (tc.temp !== undefined) {
                const col = getHeatmapColor(tc.temp);
                ctx2D.fillStyle = `rgb(${col.r}, ${col.g}, ${col.b})`;
            } else {
                ctx2D.fillStyle = '#999999';
            }
            ctx2D.fill();
            
            ctx2D.fillStyle = isHovered ? '#000000' : '#666666';
            ctx2D.font = isHovered ? 'bold 11px sans-serif' : '9px sans-serif';
            ctx2D.textAlign = tc.r >= 0 ? 'left' : 'right';
            const offsetDir = tc.r >= 0 ? 1 : -1;
            ctx2D.fillText(tc.id, x + 8 * offsetDir, y + 3);
        }
    }
    
    ctx2D.fillStyle = '#000000';
    ctx2D.font = 'bold 16px sans-serif';
    ctx2D.textAlign = 'right';
    if (sliceOrientation2D === 'horizontal') {
        ctx2D.fillText(`Horizontal Slice: EL +${sliceElevation2D}`, canvas2D.width - 20, 40);
    } else {
        ctx2D.fillText(`Vertical Slice: ${active2DSlice}°`, canvas2D.width - 20, 40);
    }
    
    const slider = document.getElementById('dateSlider');
    if (slider) {
        const date = dates[parseInt(slider.value)];
        ctx2D.font = '14px sans-serif';
        ctx2D.fillStyle = '#555555';
        ctx2D.fillText(`Date: ${date}`, canvas2D.width - 20, 65);
    }
}

function handle2DResize() {
    if (!canvas2D) return;
    canvas2D.width = canvas2D.clientWidth;
    canvas2D.height = canvas2D.clientHeight;
    
    if (!is3DMode) {
        draw2DIsotherm();
    }
}

function trigger2DRender() {
    if (is3DMode) return;
    
    initializeGrid();
    projectThermocouples(active2DSlice);
    interpolateGrid();
    draw2DIsotherm();
    drawMiniMap();
}

function drawMiniMap() {
    const canvas = document.getElementById('miniMapCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const r = w / 2 - 20;
    
    ctx.clearRect(0, 0, w, h);
    
    // Draw furnace outline
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#333333';
    ctx.lineWidth = 2;
    ctx.stroke();
    
    // Draw degree labels
    ctx.fillStyle = '#000000';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('0°', cx + r + 10, cy);
    ctx.fillText('90°', cx, cy + r + 10);
    ctx.fillText('180°', cx - r - 10, cy);
    ctx.fillText('270°', cx, cy - r - 10);
    
    // Draw TC points
    ctx.fillStyle = '#ff4444';
    for (let tc of thermocouplePositions) {
        const trueX = tc.pos.x;
        const trueY = tc.pos.z;
        const scale = r / 7600;
        const mx = cx + trueX * scale;
        const my = cy + trueY * scale;
        
        ctx.beginPath();
        ctx.arc(mx, my, 1.5, 0, 2 * Math.PI);
        ctx.fill();
    }
    
    // Draw slice indicator
    if (sliceOrientation2D === 'vertical') {
        const parts = active2DSlice.split('-');
        const angle0 = parseFloat(parts[0]);
        const rad = angle0 * Math.PI / 180;
        
        ctx.beginPath();
        ctx.moveTo(cx - r * Math.cos(rad), cy - r * Math.sin(rad));
        ctx.lineTo(cx + r * Math.cos(rad), cy + r * Math.sin(rad));
        ctx.strokeStyle = '#0078D4';
        ctx.lineWidth = 3;
        ctx.stroke();
        
        ctx.beginPath();
        ctx.arc(cx + r * Math.cos(rad), cy + r * Math.sin(rad), 4, 0, 2 * Math.PI);
        ctx.fillStyle = '#0078D4';
        ctx.fill();
    } else {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, 2 * Math.PI);
        ctx.fillStyle = 'rgba(0, 120, 212, 0.3)';
        ctx.fill();
    }
}

function onCanvasMouseMove(event) {
    if (is3DMode || projectedTCs.length === 0) return;
    
    if (isDragging2D) {
        const dx = event.clientX - startDragX;
        const dy = event.clientY - startDragY;
        panX2D = startPanX + dx;
        panY2D = startPanY + dy;
        draw2DIsotherm();
        return;
    }
    
    const rect = canvas2D.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    
    let foundNode = null;
    let minDist = 15;
    
    for (let tc of projectedTCs) {
        const px = rToX(tc.r);
        const py = zToY(tc.z);
        
        const dist = Math.sqrt((mouseX - px)**2 + (mouseY - py)**2);
        if (dist < minDist) {
            minDist = dist;
            foundNode = tc;
        }
    }
    
    const tooltip = document.getElementById('tooltip');
    
    if (foundNode) {
        hoveredNode2D = foundNode;
        document.body.style.cursor = 'pointer';
        
        tooltip.style.display = 'block';
        tooltip.style.left = event.clientX + 15 + 'px';
        tooltip.style.top = event.clientY + 15 + 'px';
        
        const tempStr = foundNode.temp !== undefined ? `${Math.round(foundNode.temp)}°C` : 'N/A';
        const locInfo = (sliceOrientation2D === 'horizontal') 
            ? `Height: ${foundNode.trueZ} mm (closest to target)`
            : `Radius: ${Math.round(Math.abs(foundNode.r))} mm (${foundNode.r >= 0 ? 'Right' : 'Left'})<br>Height: ${foundNode.z} mm`;

        tooltip.innerHTML = `
            <strong>TC ID: ${foundNode.id}</strong> (No. ${foundNode.no})<br>
            Position: ${foundNode.posName}<br>
            ${locInfo}<br>
            Temperature: <span style="color: #ff5555; font-weight: bold;">${tempStr}</span>
        `;
        
        draw2DIsotherm();
    } else {
        if (hoveredNode2D) {
            hoveredNode2D = null;
            document.body.style.cursor = 'default';
            tooltip.style.display = 'none';
            draw2DIsotherm();
        }
    }
}

function onCanvasMouseDown(event) {
    if (is3DMode) return;
    isDragging2D = true;
    startDragX = event.clientX;
    startDragY = event.clientY;
    startPanX = panX2D;
    startPanY = panY2D;
    document.body.style.cursor = 'grabbing';
}

function onCanvasMouseUp(event) {
    if (is3DMode) return;
    isDragging2D = false;
    document.body.style.cursor = 'default';
}

function onCanvasMouseLeave(event) {
    if (is3DMode) return;
    isDragging2D = false;
    document.body.style.cursor = 'default';
    const tooltip = document.getElementById('tooltip');
    if (tooltip) tooltip.style.display = 'none';
}

function onCanvasWheel(event) {
    if (is3DMode) return;
    event.preventDefault();
    
    const rect = canvas2D.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    
    const physR = xToR(mouseX);
    const physZ = yToZ(mouseY);
    
    const zoomIntensity = 0.1;
    let zoomFactor = 1.0;
    if (event.deltaY < 0) {
        zoomFactor = 1 + zoomIntensity;
    } else {
        zoomFactor = 1 - zoomIntensity;
    }
    
    zoom2D = Math.max(0.5, Math.min(10.0, zoom2D * zoomFactor));
    
    const width = canvas2D.width;
    const height = canvas2D.height;
    
    const localMinZ = (sliceOrientation2D === 'horizontal') ? -7600 : 3500;
    const localMaxZ = (sliceOrientation2D === 'horizontal') ? 7600 : 14100;
    
    const physicalWidth = maxR - minR;
    const physicalHeight = localMaxZ - localMinZ;
    const margin = 60;
    const scaleX = (width - margin * 2) / physicalWidth;
    const scaleY = (height - margin * 2) / physicalHeight;
    const baseScale = Math.min(scaleX, scaleY);
    
    const nextScale2D = baseScale * zoom2D;
    const nextOffsetX = (width - physicalWidth * nextScale2D) / 2 - minR * nextScale2D;
    const nextOffsetY = height - (height - physicalHeight * nextScale2D) / 2 + localMinZ * nextScale2D;
    
    panX2D = mouseX - (nextOffsetX + physR * nextScale2D);
    panY2D = mouseY - (nextOffsetY - physZ * nextScale2D);
    
    draw2DIsotherm();
}

function onCanvasDblClick(event) {
    if (is3DMode) return;
    zoom2D = 1.0;
    panX2D = 0;
    panY2D = 0;
    draw2DIsotherm();
}

