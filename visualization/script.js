import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let camera, scene, renderer, controls;
let raycaster, pointer;
let intersected;
let temperatureData = {};
let dates = [];
let thermocoupleMeshes = {}; // Map ID -> Mesh (Head)
let thermocouplePositions = []; // Array of { id, pos: Vector3 }
let isHeatmapMode = true;
let meshOuter, meshInner, wireframe, materialRealistic, materialHeatmap;

let idwWeights = []; // Pre-computed weights [vertexIndex][tcIndex]
let idwIndices = []; // Pre-computed TC indices [vertexIndex][tcIndex]
// Storing flat arrays for performance? Or array of objects? 
// For 6000 vertices, array of arrays is fine.


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
    controls.target.set(0, 7000, 0); // Aim at middle of furnace

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
    // Move grid down a bit? No, keep at 0. But furnace starts at Z~3946, so let's move grid to 0
    // Actually our data Z correlates to height. So 0 is ground.
    scene.add(gridHelper);

    // Raycaster for interaction
    raycaster = new THREE.Raycaster();
    pointer = new THREE.Vector2();

    // Load Data
    loadData();

    // Event listeners
    window.addEventListener('resize', onWindowResize);
    document.addEventListener('mousemove', onPointerMove);
}

async function loadData() {
    try {
        const [profileResponse, csvResponse, tempResponse] = await Promise.all([
            fetch('./profile.json'),
            fetch('./thermocouples.csv'),
            fetch('./temperatures.json')
        ]);

        const profileData = await profileResponse.json();
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

        createFurnaceMesh(profileData);
        processCSV(csvText);

        // Pre-compute weights for IDW optimization
        precomputeIDW();

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

        if (temp !== undefined) {
            let t = (temp - minTemp) / (maxTemp - minTemp);
            t = Math.max(0, Math.min(1, t)); // Clamp

            // Simple Heatmap Color (Hue: 240 -> 0)
            const color = new THREE.Color();
            color.setHSL((1.0 - t) * 0.66, 1.0, 0.5); // Blue(0.66) to Red(0.0)

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

    if (isHeatmapMode) {
        // Switch to Heatmap Material
        meshOuter.material = materialHeatmap;
        interpolateTemperatures(dailyTemps, minTemp, maxTemp);

        // Hide other elements for clean look
        if (meshInner) meshInner.visible = false;
        if (wireframe) wireframe.visible = false;

    } else {
        // Switch to Realistic Material
        meshOuter.material = materialRealistic;

        // Show components
        if (meshInner) meshInner.visible = true;
        if (wireframe) wireframe.visible = true;
    }
}

function precomputeIDW() {
    if (!meshOuter || thermocouplePositions.length === 0) return;

    const positions = meshOuter.geometry.attributes.position;
    const p = 2.0; // Power parameter

    console.log("Pre-computing IDW weights for", positions.count, "vertices and", thermocouplePositions.length, "TCs...");

    idwWeights = new Float32Array(positions.count * thermocouplePositions.length);
    // We implicitly know that for vertex i, weights are at i*numTCs to (i+1)*numTCs
    // Storing dist^p inverse

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

            idwWeights[i * thermocouplePositions.length + j] = w;
        }
    }
    console.log("IDW Pre-computation output done.");
}

function interpolateTemperatures(dailyTemps, minTemp, maxTemp) {
    if (idwWeights.length === 0) return;

    const positions = meshOuter.geometry.attributes.position;
    const colors = meshOuter.geometry.attributes.color;    // Opacity handled by material switch

    const numTCs = thermocouplePositions.length;

    // Create map of active TCs to avoid parsing IDs in the loop
    // tcIndex -> temp (or undefined)
    const activeTemps = new Float32Array(numTCs);
    const activeFlags = new Uint8Array(numTCs); // 1 if active, 0 if not

    for (let j = 0; j < numTCs; j++) {
        const tc = thermocouplePositions[j];
        const rawId = parseInt(tc.id).toString();
        const t = dailyTemps[rawId];
        if (t !== undefined) {
            activeTemps[j] = t;
            activeFlags[j] = 1;
        } else {
            activeFlags[j] = 0;
        }
    }

    for (let i = 0; i < positions.count; i++) {
        let sumWeights = 0;
        let weightedTemp = 0;
        const offset = i * numTCs;

        for (let j = 0; j < numTCs; j++) {
            if (activeFlags[j] === 0) continue; // Skip missing data

            const w = idwWeights[offset + j];
            weightedTemp += activeTemps[j] * w;
            sumWeights += w;
        }

        let finalTemp = minTemp;
        if (sumWeights > 0) {
            finalTemp = weightedTemp / sumWeights;
        }

        // Color mapping
        // Heatmap: Blue(Low) -> Green -> Red(High)
        let t = (finalTemp - minTemp) / (maxTemp - minTemp);
        t = Math.max(0, Math.min(1, t));

        // HSL mapping: Blue = 0.66, Red = 0.0
        const hue = (1.0 - t) * 0.66;

        // Convert HSL to RGB manually for speed or use THREE.Color
        const color = new THREE.Color().setHSL(hue, 1.0, 0.5);
        colors.setXYZ(i, color.r, color.g, color.b);
    }

    colors.needsUpdate = true;
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

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}

