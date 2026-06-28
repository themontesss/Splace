(function() {
    "use strict";

    // ---------- CONFIG DE FIREBASE ----------
    const firebaseConfig = {
        apiKey: "AIzaSyC6QRlDHZ5M710ZPPk6bmgePNuHHEKVy1g",
        authDomain: "splace-f8a61.firebaseapp.com",
        databaseURL: "https://splace-f8a61-default-rtdb.europe-west1.firebasedatabase.app",
        projectId: "splace-f8a61",
        storageBucket: "splace-f8a61.firebasestorage.app",
        messagingSenderId: "509262817197",
        appId: "1:509262817197:web:3961716f1e20d20988a324",
        measurementId: "G-WG7FSYKHR0"
    };

    firebase.initializeApp(firebaseConfig);
    const db = firebase.database();
    const auth = firebase.auth();

    // ---------- AUTENTICACIÓN ANÓNIMA ----------
    auth.signInAnonymously().catch(function(error) {
        console.error("Error al autenticar anónimamente:", error);
        document.getElementById("syncText").textContent = "Error de autenticación";
    });

    auth.onAuthStateChanged(function(user) {
        if (user) {
            document.getElementById("syncText").textContent = "Conectado · visible para todos";
            loadServerCooldown();
        } else {
            document.getElementById("syncText").textContent = "No autenticado";
        }
    });

    // ---------- CONFIG DEL LIENZO ----------
    const W = 1000, H = 1000;
    const CHUNK_SIZE = 100;
    const CHUNKS_X = Math.ceil(W / CHUNK_SIZE);
    const CHUNKS_Y = Math.ceil(H / CHUNK_SIZE);
    const CELL = 4;
    const COOLDOWN_MS = 4000;

    const chunksRef = db.ref('lienzo/chunks');
    const countRef = db.ref('lienzo/count');
    const activityRef = db.ref('lienzo/activity');
    const cooldownsRef = db.ref('lienzo/cooldowns');

    const PALETTE = [
        { hex: "#FFFFFF", name: "Blanco" }, { hex: "#E4E4E4", name: "Gris claro" },
        { hex: "#888888", name: "Gris" }, { hex: "#222222", name: "Negro" },
        { hex: "#FFA7D1", name: "Rosa" }, { hex: "#E50000", name: "Rojo" },
        { hex: "#E59500", name: "Naranja" }, { hex: "#A06A42", name: "Marrón" },
        { hex: "#E5D900", name: "Amarillo" }, { hex: "#94E044", name: "Lima" },
        { hex: "#02BE01", name: "Verde" }, { hex: "#00D3DD", name: "Turquesa" },
        { hex: "#0083C7", name: "Azul cielo" }, { hex: "#0000EA", name: "Azul" },
        { hex: "#CF6EE4", name: "Lila" }, { hex: "#820080", name: "Morado" },
        { hex: "#3690EA", name: "Azul medio" }, { hex: "#00CCC0", name: "Cian" },
        { hex: "#493AC1", name: "Índigo" }, { hex: "#6A5CFF", name: "Violeta" },
        { hex: "#FF3881", name: "Magenta" }, { hex: "#FF4500", name: "Bermellón" },
        { hex: "#FFFFC0", name: "Crema" }, { hex: "#9C6926", name: "Tierra" }
    ];
    const CHARS = "0123456789abcdefghijklmn";
    const idxToChar = i => CHARS[i];
    const charToIdx = c => CHARS.indexOf(c);

    function hexToRgba(hex, a) {
        const v = hex.replace("#","");
        const r = parseInt(v.substring(0,2),16), g = parseInt(v.substring(2,4),16), b = parseInt(v.substring(4,6),16);
        return `rgba(${r},${g},${b},${a})`;
    }

    // ---------- ESTADO LOCAL ----------
    const boardChunks = {};

    // ---------- DOM ----------
    const canvas = document.getElementById("board");
    const ctx = canvas.getContext("2d");
    const overlay = document.getElementById("hoverOverlay");
    const overlayCtx = overlay.getContext("2d");
    const viewport = document.getElementById("viewport");
    const loupe = document.getElementById("loupe");
    const loupeCtx = loupe.getContext("2d");
    const toastEl = document.getElementById("toast");
    const cooldownTimeEl = document.getElementById("cooldownTime");
    const paletteEl = document.getElementById("palette");
    const selectedColorNameEl = document.getElementById("selectedColorName");
    const hoverXEl = document.getElementById("hoverX");
    const hoverYEl = document.getElementById("hoverY");
    const hoverColorNameEl = document.getElementById("hoverColorName");
    const placementCountEl = document.getElementById("placementCount");
    const lastActivityMetaEl = document.getElementById("lastActivityMeta");
    const syncText = document.getElementById("syncText");
    const liveDot = document.getElementById("liveDot");
    const gridSizeLabel = document.getElementById("gridSizeLabel");
    gridSizeLabel.textContent = "1000×1000";

    canvas.width = W;
    canvas.height = H;
    overlay.width = W;
    overlay.height = H;
    canvas.style.width = (W * CELL) + "px";
    canvas.style.height = (H * CELL) + "px";
    overlay.style.width = (W * CELL) + "px";
    overlay.style.height = (H * CELL) + "px";

    // ---------- PALETA ----------
    let selectedColor = 6;
    PALETTE.forEach((c,i)=>{
        const sw = document.createElement("div");
        sw.className = "swatch" + (i===selectedColor ? " selected":"");
        sw.style.background = c.hex;
        sw.title = c.name;
        sw.addEventListener("click", ()=>{
            selectedColor = i;
            document.querySelectorAll(".swatch").forEach(s=>s.classList.remove("selected"));
            sw.classList.add("selected");
            selectedColorNameEl.textContent = c.name;
            drawHoverOverlay();
        });
        paletteEl.appendChild(sw);
    });
    selectedColorNameEl.textContent = PALETTE[selectedColor].name;

    // ---------- CHUNKS ----------
    function chunkKey(cx, cy) { return cy + "_" + cx; }
    function getChunkCoords(x, y) {
        return { cx: Math.floor(x / CHUNK_SIZE), cy: Math.floor(y / CHUNK_SIZE) };
    }
    function getPixel(x, y) {
        const { cx, cy } = getChunkCoords(x, y);
        const key = chunkKey(cx, cy);
        const chunk = boardChunks[key];
        if (!chunk) return 0;
        const localX = x - cx * CHUNK_SIZE;
        const localY = y - cy * CHUNK_SIZE;
        const idx = localY * CHUNK_SIZE + localX;
        return charToIdx(chunk[idx]);
    }
    function setPixel(x, y, colorIndex) {
        const { cx, cy } = getChunkCoords(x, y);
        const key = chunkKey(cx, cy);
        let chunk = boardChunks[key];
        if (!chunk) {
            chunk = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(0).map(idxToChar).join('');
        } else {
            chunk = chunk.split('');
        }
        const localX = x - cx * CHUNK_SIZE;
        const localY = y - cy * CHUNK_SIZE;
        chunk[localY * CHUNK_SIZE + localX] = idxToChar(colorIndex);
        boardChunks[key] = chunk.join('');
        return key;
    }

    function renderChunk(cx, cy) {
        const key = chunkKey(cx, cy);
        const chunk = boardChunks[key];
        if (!chunk) return;
        const startX = cx * CHUNK_SIZE;
        const startY = cy * CHUNK_SIZE;
        for (let y = 0; y < CHUNK_SIZE; y++) {
            for (let x = 0; x < CHUNK_SIZE; x++) {
                const idx = y * CHUNK_SIZE + x;
                const colorIdx = charToIdx(chunk[idx]);
                ctx.fillStyle = PALETTE[colorIdx].hex;
                ctx.fillRect(startX + x, startY + y, 1, 1);
            }
        }
    }
    function clearChunk(cx, cy) {
        const startX = cx * CHUNK_SIZE;
        const startY = cy * CHUNK_SIZE;
        ctx.clearRect(startX, startY, CHUNK_SIZE, CHUNK_SIZE);
    }

    // ---------- VISIBILIDAD DE CHUNKS ----------
    const activeChunkSubs = {};
    function subscribeChunk(cx, cy) {
        const key = chunkKey(cx, cy);
        if (activeChunkSubs[key]) return;
        const ref = chunksRef.child(key);
        const callback = snap => {
            const val = snap.val();
            if (val && typeof val === 'string' && val.length === CHUNK_SIZE * CHUNK_SIZE) {
                boardChunks[key] = val;
                renderChunk(cx, cy);
                if (hoverCell) {
                    const { cx: hcx, cy: hcy } = getChunkCoords(hoverCell.x, hoverCell.y);
                    if (hcx === cx && hcy === cy) {
                        renderLoupe(hoverCell.x, hoverCell.y);
                        hoverColorNameEl.textContent = PALETTE[getPixel(hoverCell.x, hoverCell.y)].name;
                    }
                }
            } else {
                boardChunks[key] = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(0).map(idxToChar).join('');
                renderChunk(cx, cy);
            }
        };
        ref.on('value', callback);
        activeChunkSubs[key] = { ref, callback };
    }
    function unsubscribeChunk(cx, cy) {
        const key = chunkKey(cx, cy);
        const sub = activeChunkSubs[key];
        if (sub) {
            sub.ref.off('value', sub.callback);
            delete activeChunkSubs[key];
            clearChunk(cx, cy);
        }
    }
    function getVisibleChunks() {
        const rect = viewport.getBoundingClientRect();
        const invZoom = 1 / zoom;
        const left = (-panX) * invZoom / CELL;
        const top = (-panY) * invZoom / CELL;
        const right = (rect.width - panX) * invZoom / CELL;
        const bottom = (rect.height - panY) * invZoom / CELL;
        const minX = Math.max(0, Math.floor(left));
        const minY = Math.max(0, Math.floor(top));
        const maxX = Math.min(W - 1, Math.ceil(right));
        const maxY = Math.min(H - 1, Math.ceil(bottom));
        const chunks = new Set();
        const startCX = Math.floor(minX / CHUNK_SIZE);
        const startCY = Math.floor(minY / CHUNK_SIZE);
        const endCX = Math.floor(maxX / CHUNK_SIZE);
        const endCY = Math.floor(maxY / CHUNK_SIZE);
        for (let cy = startCY; cy <= endCY; cy++) {
            for (let cx = startCX; cx <= endCX; cx++) {
                if (cx >= 0 && cx < CHUNKS_X && cy >= 0 && cy < CHUNKS_Y) {
                    chunks.add(chunkKey(cx, cy));
                }
            }
        }
        return chunks;
    }
    function updateVisibleChunks() {
        const visible = getVisibleChunks();
        for (const key of visible) {
            const [cy, cx] = key.split('_').map(Number);
            subscribeChunk(cx, cy);
        }
        for (const key in activeChunkSubs) {
            if (!visible.has(key)) {
                const [cy, cx] = key.split('_').map(Number);
                unsubscribeChunk(cx, cy);
            }
        }
    }

    // ---------- TRANSFORMACIONES ----------
    let zoom = 1, panX = 0, panY = 0;
    function applyTransform() {
        const t = `translate(${panX}px, ${panY}px) scale(${zoom})`;
        canvas.style.transform = t;
        overlay.style.transform = t;
        updateVisibleChunks();
    }
    function fitToViewport() {
        const vw = viewport.clientWidth, vh = viewport.clientHeight;
        const boardW = W * CELL, boardH = H * CELL;
        zoom = Math.min(vw / boardW, vh / boardH) * 0.92;
        zoom = Math.max(0.1, Math.min(zoom, 20));
        panX = (vw - boardW * zoom) / 2;
        panY = (vh - boardH * zoom) / 2;
        applyTransform();
    }

    // ---------- HOVER OVERLAY ----------
    let hoverCell = null;
    function drawHoverOverlay() {
        overlayCtx.clearRect(0, 0, W, H);
        if (!hoverCell || isDragging) return;
        const { x, y } = hoverCell;
        const waiting = Date.now() < cooldownUntil;
        overlayCtx.fillStyle = hexToRgba(PALETTE[selectedColor].hex, waiting ? 0.32 : 0.6);
        overlayCtx.fillRect(x, y, 1, 1);
        overlayCtx.lineWidth = 0.14;
        overlayCtx.strokeStyle = waiting ? "#ff6f67" : "#5b8dff";
        overlayCtx.strokeRect(x + 0.07, y + 0.07, 0.86, 0.86);
    }

    // ---------- LUPA ----------
    const LOUPE_RADIUS = 3;
    const LOUPE_CELL = loupe.width / (LOUPE_RADIUS * 2 + 1);
    function renderLoupe(cellX, cellY) {
        loupeCtx.clearRect(0, 0, loupe.width, loupe.height);
        for (let dy = -LOUPE_RADIUS; dy <= LOUPE_RADIUS; dy++) {
            for (let dx = -LOUPE_RADIUS; dx <= LOUPE_RADIUS; dx++) {
                const gx = cellX + dx, gy = cellY + dy;
                let color = "#262a33";
                if (gx >= 0 && gx < W && gy >= 0 && gy < H) {
                    const pixelColor = getPixel(gx, gy);
                    color = PALETTE[pixelColor]?.hex || color;
                }
                loupeCtx.fillStyle = color;
                loupeCtx.fillRect((dx + LOUPE_RADIUS) * LOUPE_CELL, (dy + LOUPE_RADIUS) * LOUPE_CELL, LOUPE_CELL, LOUPE_CELL);
            }
        }
        loupeCtx.strokeStyle = "#5b8dff";
        loupeCtx.lineWidth = 2;
        loupeCtx.strokeRect(LOUPE_RADIUS * LOUPE_CELL + 1, LOUPE_RADIUS * LOUPE_CELL + 1, LOUPE_CELL - 2, LOUPE_CELL - 2);
    }
    function clearLoupe() {
        loupeCtx.clearRect(0, 0, loupe.width, loupe.height);
        hoverXEl.textContent = "—"; hoverYEl.textContent = "—";
        hoverColorNameEl.textContent = "apunta al lienzo";
        hoverCell = null;
        drawHoverOverlay();
    }

    // ---------- COOLDOWN CONTROLADO POR SERVIDOR ----------
    let serverCooldownUntil = 0;
    let cooldownUntil = 0;

    function updateCooldownDisplay() {
        const now = Date.now();
        const effective = Math.max(cooldownUntil, serverCooldownUntil);
        if (now >= effective) {
            cooldownTimeEl.textContent = "LISTO";
            cooldownTimeEl.classList.add("ready");
        } else {
            const remaining = effective - now;
            const s = Math.ceil(remaining / 1000);
            cooldownTimeEl.textContent = "0:" + String(s).padStart(2, "0");
            cooldownTimeEl.classList.remove("ready");
        }
    }
    setInterval(updateCooldownDisplay, 250);

    async function loadServerCooldown() {
        if (!auth.currentUser) return;
        const ref = cooldownsRef.child(auth.currentUser.uid).child('lastPlacement');
        const snap = await ref.once('value');
        const val = snap.val();
        if (val) {
            serverCooldownUntil = val + COOLDOWN_MS;
        } else {
            serverCooldownUntil = 0;
        }
        updateCooldownDisplay();
    }

    async function updateServerCooldown() {
        if (!auth.currentUser) return;
        const ref = cooldownsRef.child(auth.currentUser.uid).child('lastPlacement');
        await ref.set(firebase.database.ServerValue.TIMESTAMP);
        await loadServerCooldown();
    }

    // ---------- EVENTOS DE RATÓN ----------
    let isPointerDown = false, isDragging = false;
    let startClientX = 0, startClientY = 0, startPanX = 0, startPanY = 0;
    const DRAG_THRESHOLD = 5;

    canvas.addEventListener("pointerdown", (e) => {
        isPointerDown = true; isDragging = false;
        startClientX = e.clientX; startClientY = e.clientY;
        startPanX = panX; startPanY = panY;
        canvas.setPointerCapture(e.pointerId);
    });

    canvas.addEventListener("pointermove", (e) => {
        if (isPointerDown) {
            const dx = e.clientX - startClientX, dy = e.clientY - startClientY;
            if (!isDragging && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
                isDragging = true;
                viewport.classList.add("dragging");
                drawHoverOverlay();
            }
            if (isDragging) {
                panX = startPanX + dx; panY = startPanY + dy;
                applyTransform();
            }
        }
        const cell = clientToCell(e.clientX, e.clientY);
        if (cell) {
            hoverCell = cell;
            hoverXEl.textContent = cell.x; hoverYEl.textContent = cell.y;
            hoverColorNameEl.textContent = PALETTE[getPixel(cell.x, cell.y)].name;
            renderLoupe(cell.x, cell.y);
            drawHoverOverlay();
        } else {
            clearLoupe();
        }
    });

    function endPointer(e) {
        if (isPointerDown && !isDragging) {
            const cell = clientToCell(e.clientX, e.clientY);
            if (cell) placePixel(cell.x, cell.y);
        }
        isPointerDown = false; isDragging = false;
        viewport.classList.remove("dragging");
        drawHoverOverlay();
    }
    canvas.addEventListener("pointerup", endPointer);
    canvas.addEventListener("pointercancel", () => {
        isPointerDown = false; isDragging = false;
        viewport.classList.remove("dragging");
        drawHoverOverlay();
    });
    canvas.addEventListener("pointerleave", clearLoupe);

    viewport.addEventListener("wheel", (e) => {
        e.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
        const prevZoom = zoom;
        const factor = e.deltaY < 0 ? 1.15 : 1/1.15;
        zoom = Math.max(0.1, Math.min(zoom * factor, 20));
        panX = cx - (cx - panX) * (zoom / prevZoom);
        panY = cy - (cy - panY) * (zoom / prevZoom);
        applyTransform();
    }, { passive: false });

    document.getElementById("zoomIn").addEventListener("click", () => {
        zoom = Math.min(zoom * 1.25, 20); applyTransform();
    });
    document.getElementById("zoomOut").addEventListener("click", () => {
        zoom = Math.max(zoom / 1.25, 0.1); applyTransform();
    });
    document.getElementById("zoomFit").addEventListener("click", fitToViewport);

    window.addEventListener("resize", () => {
        if (zoom < 0.11) fitToViewport();
        else updateVisibleChunks();
    });

    function clientToCell(clientX, clientY) {
        const rect = canvas.getBoundingClientRect();
        const relX = (clientX - rect.left) / rect.width;
        const relY = (clientY - rect.top) / rect.height;
        if (relX < 0 || relX >= 1 || relY < 0 || relY >= 1) return null;
        return { x: Math.floor(relX * W), y: Math.floor(relY * H) };
    }

    // ---------- COLOCAR PÍXEL (SEGURIDAD ESTRICTA) ----------
    let placementCount = 0;

    async function placePixel(x, y) {
        const now = Date.now();
        if (!auth.currentUser) {
            showToast("Iniciando sesión anónima...", true);
            await auth.signInAnonymously();
            if (!auth.currentUser) {
                showToast("Error de autenticación", true);
                return;
            }
        }

        await loadServerCooldown();
        const effectiveCooldown = Math.max(cooldownUntil, serverCooldownUntil);
        if (now < effectiveCooldown) {
            const wait = Math.ceil((effectiveCooldown - now) / 1000);
            showToast(`Debes esperar ${wait}s (control del servidor)`, true);
            return;
        }

        const { cx, cy } = getChunkCoords(x, y);
        const key = setPixel(x, y, selectedColor);
        renderChunk(cx, cy);
        const previousCooldownUntil = cooldownUntil;
        cooldownUntil = now + COOLDOWN_MS;
        updateCooldownDisplay();
        drawHoverOverlay();

        try {
            await chunksRef.child(key).set(boardChunks[key]);
            await updateServerCooldown();
            await countRef.transaction(current => (current || 0) + 1);
            const activity = { x, y, c: selectedColor, t: Date.now() };
            await activityRef.set(JSON.stringify(activity));
            showToast(`Píxel colocado en (${x}, ${y})`);
        } catch (e) {
            console.error("Error al guardar (posible violación de seguridad):", e);
            boardChunks[key] = boardChunks[key].split('');
            const localX = x - cx * CHUNK_SIZE;
            const localY = y - cy * CHUNK_SIZE;
            boardChunks[key][localY * CHUNK_SIZE + localX] = idxToChar(0);
            boardChunks[key] = boardChunks[key].join('');
            renderChunk(cx, cy);
            cooldownUntil = previousCooldownUntil;
            updateCooldownDisplay();
            drawHoverOverlay();
            showToast("Acción rechazada por el servidor (seguridad)", true);
        }
    }

    // ---------- SINCRONIZACIÓN GLOBAL ----------
    countRef.on('value', snap => {
        const val = snap.val();
        if (val !== null) {
            placementCount = parseInt(val, 10) || 0;
            placementCountEl.textContent = placementCount.toLocaleString("es-ES");
        }
    });

    activityRef.on('value', snap => {
        const val = snap.val();
        if (val) {
            try {
                const a = typeof val === 'string' ? JSON.parse(val) : val;
                const secs = Math.max(0, Math.round((Date.now() - a.t) / 1000));
                let when = secs < 60 ? `hace ${secs}s` : `hace ${Math.round(secs / 60)}min`;
                lastActivityMetaEl.textContent = `Última: (${a.x},${a.y}) ${when}`;
            } catch (e) {}
        }
    });

    db.ref('.info/connected').on('value', snap => {
        if (snap.val() === true) {
            syncText.textContent = "Conectado · visible para todos";
        } else {
            syncText.textContent = "Sin conexión";
        }
    });

    // ---------- TOAST ----------
    let toastTimer;
    function showToast(msg, warn) {
        toastEl.textContent = msg;
        toastEl.classList.toggle("warn", !!warn);
        toastEl.classList.add("show");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
    }

    // ---------- ADMIN ----------
    document.getElementById("exportBtn").addEventListener("click", () => {
        const data = {
            version: 1,
            width: W,
            height: H,
            chunks: boardChunks,
            count: placementCount,
            exportedAt: new Date().toISOString()
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "splace-lienzo-1000x1000-" + new Date().toISOString().slice(0,10) + ".json";
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast("Lienzo exportado (solo chunks cargados)");
    });

    document.getElementById("importBtn").addEventListener("click", () => {
        document.getElementById("importFile").click();
    });

    document.getElementById("importFile").addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (!data.chunks || typeof data.chunks !== 'object') throw new Error("Formato inválido");
            for (const [key, chunkStr] of Object.entries(data.chunks)) {
                if (typeof chunkStr === 'string' && chunkStr.length === CHUNK_SIZE * CHUNK_SIZE) {
                    boardChunks[key] = chunkStr;
                    const [cy, cx] = key.split('_').map(Number);
                    renderChunk(cx, cy);
                    await chunksRef.child(key).set(chunkStr);
                }
            }
            if (data.count !== undefined) {
                placementCount = data.count;
                await countRef.set(placementCount);
                placementCountEl.textContent = placementCount.toLocaleString("es-ES");
            }
            showToast("✅ Lienzo importado correctamente");
        } catch (err) {
            showToast("❌ Error al importar: " + err.message, true);
        }
        e.target.value = "";
    });

    document.getElementById("resetBtn").addEventListener("click", async () => {
        if (!confirm("¿Borrar TODO el lienzo de 1000x1000? No se puede deshacer.")) return;
        if (!confirm("Confirmación final: ¿Reiniciar a blanco?")) return;
        for (const key in activeChunkSubs) {
            const [cy, cx] = key.split('_').map(Number);
            unsubscribeChunk(cx, cy);
        }
        for (const key in boardChunks) delete boardChunks[key];
        ctx.clearRect(0, 0, W, H);
        await chunksRef.remove();
        await countRef.set(0);
        placementCount = 0;
        placementCountEl.textContent = "0";
        await activityRef.set(JSON.stringify({x:0,y:0,c:0,t:Date.now()}));
        showToast("🗑️ Lienzo reiniciado");
        updateVisibleChunks();
    });

    // ---------- INICIO ----------
    fitToViewport();
    updateVisibleChunks();
})();