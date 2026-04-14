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
let globalProfileData = null;
let isCroppedMode = true;
let isIsolatedMode = false;

let idwWeightsOuter = []; // Pre-computed weights [vertexIndex][tcIndex]
let bottomPlanes = [];
let bottomPlaneWeights = [];
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

