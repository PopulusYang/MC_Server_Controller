/**
 * Minecraft Web Controller - Client Side
 * Handles real-time communication, console updates, and UI interactions.
 * 
 * @license MIT
 * @version 1.0.0
 */

const socket = io();

// DOM 元素定义 (移至顶部确保各处可用)
const loginOverlay = document.getElementById('login-overlay');
const loginMsg = document.getElementById('login-msg');
const loginInput = document.getElementById('login-input');
const consoleContainer = document.getElementById('console-container');
const chatContainer = document.getElementById('chat-container');
const statusBadge = document.getElementById('status-badge');
const versionBadge = document.getElementById('version-badge');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const cmdInput = document.getElementById('cmd-input');
const playerListEl = document.getElementById('player-list');
const allPlayerListEl = document.getElementById('all-player-list');
const playerCountEl = document.getElementById('player-count');
const valCpu = document.getElementById('val-cpu');
const valMem = document.getElementById('val-mem');
const valRx = document.getElementById('val-rx');
const valTx = document.getElementById('val-tx');
const cpuBar = document.getElementById('cpu-bar');
const memBar = document.getElementById('mem-bar');

const STORAGE_KEY = 'mc_server_pwd';

socket.on('connect', () => {
    console.log('Socket connected');
    const savedPwd = localStorage.getItem(STORAGE_KEY);
    if (savedPwd) {
        console.log('Attempting auto-login...');
        socket.emit('login', savedPwd);
    }
});

socket.on('login-success', () => {
    console.log('Login successful');
    loginOverlay.style.display = 'none';
    if (loginInput.value) {
        localStorage.setItem(STORAGE_KEY, loginInput.value);
    }
});

socket.on('server-version', (data) => {
    console.log('Server version received:', data);
    if (versionBadge) {
        const { gameVersion, loaderType, loaderVersion } = data;
        let text = `MC ${gameVersion}`;
        if (loaderType !== 'Vanilla') {
            text += ` (${loaderType}${loaderVersion ? ' ' + loaderVersion : ''})`;
        }
        versionBadge.textContent = text;
    }
});

socket.on('login-fail', () => {
    console.log('Login failed');
    loginMsg.style.display = 'block';
    loginMsg.textContent = '密码错误';
    loginInput.value = '';
    localStorage.removeItem(STORAGE_KEY);
    loginOverlay.style.display = 'flex';
});

function doLogin() {
    console.log('Login button clicked');
    const pwd = loginInput.value;
    if(!pwd) {
        console.warn('Empty password');
        return;
    }
    socket.emit('login', pwd);
}

socket.on('connect_error', (err) => {
    console.error('Socket connection error:', err);
});

// Chart.js 历史数据
const MAX_POINTS = 30;
const chartData = {
    cpu: Array(MAX_POINTS).fill(0),
    ram: Array(MAX_POINTS).fill(0)
};
let statusChart;

function initChart() {
    const ctx = document.getElementById('statusChart').getContext('2d');
    statusChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: Array(MAX_POINTS).fill(''),
            datasets: [{
                label: 'CPU %',
                data: chartData.cpu,
                borderColor: '#007ACC',
                borderWidth: 2,
                pointRadius: 0,
                fill: true,
                backgroundColor: 'rgba(0, 122, 204, 0.1)',
                tension: 0.3
            }, {
                label: 'RAM GB',
                data: chartData.ram,
                borderColor: '#9c27b0',
                borderWidth: 2,
                pointRadius: 0,
                fill: true,
                backgroundColor: 'rgba(156, 39, 176, 0.1)',
                tension: 0.3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            scales: {
                y: { beginAtZero: true, grid: { color: '#333' }, ticks: { color: '#888', font: { size: 10 } } },
                x: { display: false }
            },
            plugins: {
                legend: { display: true, labels: { color: '#ccc', font: { size: 10 }, boxWidth: 10 } }
            }
        }
    });
}

window.addEventListener('load', initChart);

function openFeatures() {
    document.getElementById('features-overlay').style.display = 'flex';
    socket.emit('get-server-properties');
}

function closeFeatures() {
    document.getElementById('features-overlay').style.display = 'none';
}

// --- Game Rules Logic ---
function openGameRules() {
    if (statusBadge.textContent.toLowerCase() !== 'running') {
        alert('服务器未运行，无法配置游戏规则！');
        return;
    }
    
    document.getElementById('gamerules-overlay').style.display = 'flex';
    renderGameRules();
    // Fetch current values
    const keys = Object.keys(GAMERULE_DEFS);
    socket.emit('query-gamerules', keys);
}

function closeGameRules() {
    document.getElementById('gamerules-overlay').style.display = 'none';
}

function updateGameRule(key, value) {
    socket.emit('set-gamerule', { key, value });
}


function toggleProperty(key, checkbox) {
    const newValue = checkbox.checked ? 'true' : 'false';
    socket.emit('update-server-property', { key, value: newValue });
}

function updateProperty(key, value) {
    socket.emit('update-server-property', { key, value: value });
}

// MOTD 编辑器逻辑
function openMotdEditor(currentMotd) {
    document.getElementById('motd-input').value = currentMotd || '';
    document.getElementById('motd-overlay').style.display = 'flex';
}

function closeMotdEditor() {
    document.getElementById('motd-overlay').style.display = 'none';
}

function addMotdCode(code) {
   const input = document.getElementById('motd-input');
   const start = input.selectionStart;
   const end = input.selectionEnd;
   const text = input.value;
   const before = text.substring(0, start);
   const after = text.substring(end, text.length);
   input.value = before + code + after;
   input.selectionStart = input.selectionEnd = start + code.length;
   input.focus();
}

function saveMotd() {
    const newMotd = document.getElementById('motd-input').value;
    socket.emit('update-server-property', { key: 'motd', value: newMotd });
    closeMotdEditor();
}

let g_allPlayers = [];
let g_bannedPlayers = [];
let g_opsPlayers = []; 
let g_whitelistPlayers = []; 
let g_onlinePlayersList = []; 

// 渲染“历史/所有”玩家列表
function renderAllPlayers() {
    allPlayerListEl.innerHTML = '';
    g_allPlayers.forEach(player => {
        const isBanned = g_bannedPlayers.includes(player);
        const li = document.createElement('li');

        const infoDiv = document.createElement('div');
        infoDiv.className = 'player-info';
        infoDiv.textContent = player;
        if (isBanned) {
            infoDiv.style.color = '#f44336';
            infoDiv.style.textDecoration = 'line-through';
        }

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'player-actions';

        if (isBanned) {
            const btnPardon = document.createElement('button');
            btnPardon.className = 'btn-pardon';
            btnPardon.textContent = '恢复';
            btnPardon.onclick = () => confirmAction('解封', player, () => socket.emit('pardon-player', player));
            actionsDiv.appendChild(btnPardon);
        } else {
            const btnBan = document.createElement('button');
            btnBan.className = 'btn-ban';
            btnBan.textContent = '拉黑';
            btnBan.onclick = () => confirmAction('封禁', player, () => socket.emit('ban-player', player));
            actionsDiv.appendChild(btnBan);
        }

        li.appendChild(infoDiv);
        li.appendChild(actionsDiv);
        allPlayerListEl.appendChild(li);
    });
    
    if (document.getElementById('player-manage-overlay').style.display === 'flex') {
        renderPlayerManageList();
    }
}

// --- Player Management UI ---
function openPlayerManage() {
    document.getElementById('player-manage-overlay').style.display = 'flex';
    renderPlayerManageList();
}

function closePlayerManage() {
    document.getElementById('player-manage-overlay').style.display = 'none';
}

function renderPlayerManageList() {
    const listEl = document.getElementById('pm-list');
    const searchVal = document.getElementById('pm-search').value.toLowerCase();
    listEl.innerHTML = '';

    const uniquePlayers = new Set([...g_allPlayers, ...g_bannedPlayers, ...g_opsPlayers]);
    const sortedPlayers = Array.from(uniquePlayers).sort();

    sortedPlayers.forEach(player => {
        if (searchVal && !player.toLowerCase().includes(searchVal)) return;

        const isBanned = g_bannedPlayers.includes(player);
        const isOp = g_opsPlayers.includes(player);
        const isWhitelisted = g_whitelistPlayers.includes(player);
        const isOnline = g_onlinePlayersList.includes(player);

        const itemDiv = document.createElement('div');
        itemDiv.className = 'feature-item';
        itemDiv.style.display = 'flex';
        itemDiv.style.flexWrap = 'wrap'; 
        itemDiv.style.alignItems = 'flex-start';

        // Avatar Container
        const avatarContainer = document.createElement('div');
        avatarContainer.style.position = 'relative';
        avatarContainer.style.marginRight = '10px';

        const avatarImg = document.createElement('img');
        avatarImg.src = `https://minotar.net/avatar/${player}/32`;
        avatarImg.style.width = '32px';
        avatarImg.style.height = '32px';
        avatarImg.style.borderRadius = '4px';
        avatarImg.onerror = function() { this.style.display='none'; } 
        
        avatarContainer.appendChild(avatarImg);

        if (isOnline) {
            const onlineDot = document.createElement('div');
            onlineDot.style.position = 'absolute';
            onlineDot.style.bottom = '-2px';
            onlineDot.style.right = '-2px';
            onlineDot.style.width = '10px';
            onlineDot.style.height = '10px';
            onlineDot.style.backgroundColor = '#4CAF50';
            onlineDot.style.borderRadius = '50%';
            onlineDot.style.border = '2px solid #2d2d2d';
            onlineDot.title = '在线';
            avatarContainer.appendChild(onlineDot);
        }
        itemDiv.appendChild(avatarContainer);

        const textContainer = document.createElement('div');
        textContainer.style.flex = '1';
        textContainer.style.minWidth = '120px';
        
        const nameSpan = document.createElement('div');
        nameSpan.style.fontWeight = 'bold';
        nameSpan.textContent = player;
        nameSpan.style.color = isOp ? '#4CAF50' : '#ddd';
        if (isBanned) {
            nameSpan.style.color = '#f44336';
            nameSpan.style.textDecoration = 'line-through';
        }
        textContainer.appendChild(nameSpan);

        const tagsDiv = document.createElement('div');
        tagsDiv.style.display = 'flex';
        tagsDiv.style.gap = '5px';
        tagsDiv.style.marginTop = '2px';
        tagsDiv.style.flexWrap = 'wrap';

        if (isOp) {
            const tag = document.createElement('span');
            tag.textContent = 'OP';
            tag.style.background = '#4CAF50';
            tag.style.color = 'white';
            tag.style.fontSize = '10px';
            tag.style.padding = '1px 4px';
            tag.style.borderRadius = '2px';
            tagsDiv.appendChild(tag);
        }
        if (isWhitelisted) {
            const tag = document.createElement('span');
            tag.textContent = 'WL';
            tag.style.background = '#2196F3';
            tag.style.color = 'white';
            tag.style.fontSize = '10px';
            tag.style.padding = '1px 4px';
            tag.style.borderRadius = '2px';
            tagsDiv.appendChild(tag);
        }
        if (isBanned) {
            const tag = document.createElement('span');
            tag.textContent = 'BANNED';
            tag.style.background = '#f44336';
            tag.style.color = 'white';
            tag.style.fontSize = '10px';
            tag.style.padding = '1px 4px';
            tag.style.borderRadius = '2px';
            tagsDiv.appendChild(tag);
        }
        textContainer.appendChild(tagsDiv);
        itemDiv.appendChild(textContainer);

        const actionsDiv = document.createElement('div');
        actionsDiv.style.display = 'flex';
        actionsDiv.style.flexDirection = 'column';
        actionsDiv.style.gap = '5px';
        actionsDiv.style.alignItems = 'flex-end';

        const configRow = document.createElement('div');
        configRow.style.display = 'flex';
        configRow.style.gap = '5px';

        const btnOp = createMiniBtn(isOp ? '取消OP' : 'OP', isOp ? '#FF9800' : '#444', 
            () => socket.emit(isOp ? 'deop-player' : 'op-player', player));
        configRow.appendChild(btnOp);

        const btnWl = createMiniBtn(isWhitelisted ? '-WL' : '+WL', isWhitelisted ? '#2196F3' : '#444', 
            () => socket.emit(isWhitelisted ? 'whitelist-remove' : 'whitelist-add', player));
        configRow.appendChild(btnWl);

        const btnBan = createMiniBtn(isBanned ? '解封' : '封禁', isBanned ? '#4CAF50' : '#f44336', 
            () => socket.emit(isBanned ? 'pardon-player' : 'ban-player', player));
        configRow.appendChild(btnBan);

        actionsDiv.appendChild(configRow);

        if (isOnline) {
            const onlineRow = document.createElement('div');
            onlineRow.style.display = 'flex';
            onlineRow.style.gap = '5px';
            onlineRow.style.alignItems = 'center';

            const gmSelect = document.createElement('select');
            gmSelect.style.width = '60px';
            gmSelect.style.height = '20px';
            gmSelect.style.fontSize = '10px';
            gmSelect.style.background = '#333';
            gmSelect.style.color = 'white';
            gmSelect.style.border = '1px solid #555';
            
            const gms = {'survival':'存', 'creative':'创', 'adventure':'冒', 'spectator':'旁'};
            for (const [mode, label] of Object.entries(gms)) {
                const opt = document.createElement('option');
                opt.value = mode;
                opt.textContent = label;
                gmSelect.appendChild(opt);
            }
            const defaultOpt = document.createElement('option');
            defaultOpt.textContent = '模式';
            defaultOpt.value = '';
            defaultOpt.selected = true;
            defaultOpt.disabled = true;
            gmSelect.prepend(defaultOpt);

            gmSelect.onchange = () => {
                if (gmSelect.value) {
                    socket.emit('set-player-gamemode', { name: player, mode: gmSelect.value });
                    gmSelect.value = ''; 
                }
            };
            onlineRow.appendChild(gmSelect);

            const btnClear = createMiniBtn('清包', '#555', () => {
                if(confirm(`清空 ${player} 背包?`)) socket.emit('clear-player-inventory', player);
            });
            onlineRow.appendChild(btnClear);

            const btnMsg = createMiniBtn('私信', '#6a1b9a', () => {
                openPrivateMsg(player);
            });
            onlineRow.appendChild(btnMsg);

            const btnKick = createMiniBtn('T出', '#d32f2f', () => {
                if(confirm(`踢出 ${player}?`)) socket.emit('kick-player', player);
            });
            onlineRow.appendChild(btnKick);

            actionsDiv.appendChild(onlineRow);
        }

        itemDiv.appendChild(actionsDiv);
        listEl.appendChild(itemDiv);
    });
}

function createMiniBtn(text, color, onClick) {
    const btn = document.createElement('button');
    btn.className = 'menu-btn';
    btn.style.padding = '2px 5px';
    btn.style.fontSize = '10px';
    btn.style.margin = '0';
    btn.style.minWidth = '30px';
    btn.style.backgroundColor = color;
    btn.textContent = text;
    btn.onclick = onClick;
    return btn;
}

function confirmAction(action, name, callback) {
    if (confirm(`确定要${action}玩家 ${name} 吗?`)) {
        callback();
    }
}

function switchTab(tab) {
    document.querySelectorAll('.sidebar-tab').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.list-container').forEach(el => el.classList.remove('active'));
    document.getElementById(`tab-${tab}`).classList.add('active');
    document.getElementById(`view-${tab}`).classList.add('active');
}

let currentConsoleTab = 'log';
function switchConsoleTab(tab) {
    currentConsoleTab = tab;
    const logTab = document.getElementById('tab-log');
    const chatTab = document.getElementById('tab-chat');
    const consoleBox = document.getElementById('console-container');
    const chatBox = document.getElementById('chat-container');

    [logTab, chatTab].forEach(t => t.classList.remove('active'));
    [consoleBox, chatBox].forEach(b => b.style.display = 'none');

    if (tab === 'log') {
        logTab.classList.add('active');
        consoleBox.style.display = 'block';
        cmdInput.placeholder = '输入命令...';
    } else if (tab === 'chat') {
        chatTab.classList.add('active');
        chatBox.style.display = 'block';
        cmdInput.placeholder = '发送聊天 (自动添加 /me)...';
    }
}

function openPrivateMsg(player) {
    switchConsoleTab('chat');
    cmdInput.value = `/msg ${player} `;
    cmdInput.focus();
    document.querySelector('.card-console').scrollIntoView({ behavior: 'smooth' });
}

socket.on('log', (data) => {
    appendLog(data);
});

socket.on('log-history', (history) => {
    consoleContainer.innerHTML = '';
    history.forEach(line => appendLog(line));
    const sep = document.createElement('div');
    sep.textContent = '--- Livesync Start ---';
    sep.style.color = '#555';
    sep.style.textAlign = 'center';
    sep.style.margin = '10px 0';
    consoleContainer.appendChild(sep);
    consoleContainer.scrollTop = consoleContainer.scrollHeight;
});

function appendLog(text) {
    const line = document.createElement('div');
    line.className = 'log-line';
    line.textContent = text;
    if (text.includes('WARN')) line.className += ' warn';
    if (text.includes('ERROR') || text.includes('Exception')) line.className += ' error';
    consoleContainer.appendChild(line);
    consoleContainer.scrollTop = consoleContainer.scrollHeight;

    const chatRegex = /\[\d{2}:\d{2}:\d{2}\] \[Server thread\/INFO\]: (?:\[Not Secure\] )?<([^>]+)> (.+)/;
    const meRegex = /\[\d{2}:\d{2}:\d{2}\] \[Server thread\/INFO\]: (?:\[Not Secure\] )?\* (\w+) (.+)/;

    let chatMatch = text.match(chatRegex);
    let isMe = false;
    if (!chatMatch) {
        chatMatch = text.match(meRegex);
        isMe = true;
    }

    if (chatMatch) {
        const playerName = chatMatch[1];
        const message = chatMatch[2];
        const chatLine = document.createElement('div');
        chatLine.style.marginBottom = '5px';
        chatLine.style.lineHeight = '1.4';
        const nameSpan = document.createElement('span');
        nameSpan.style.color = '#4CAF50';
        nameSpan.style.fontWeight = 'bold';
        nameSpan.textContent = isMe ? `* ${playerName} ` : `<${playerName}> `;
        const msgSpan = document.createElement('span');
        msgSpan.textContent = message;
        if (isMe) msgSpan.style.fontStyle = 'italic';
        if (isMe) nameSpan.style.color = '#e040fb';
        chatLine.appendChild(nameSpan);
        chatLine.appendChild(msgSpan);
        chatContainer.appendChild(chatLine);
        chatContainer.scrollTop = chatContainer.scrollHeight;
        if (chatContainer.childNodes.length > 200) {
            chatContainer.removeChild(chatContainer.firstChild);
        }
    }

    const whisperRegex1 = /\[\d{2}:\d{2}:\d{2}\] \[Server thread\/INFO\]: (\w+) whispers to (\w+): (.+)/;
    const whisperRegex2 = /\[\d{2}:\d{2}:\d{2}\] \[Server thread\/INFO\]: \[(\w+) -> (\w+)\] (.+)/;
    const whisperRegex3 = /\[\d{2}:\d{2}:\d{2}\] \[Server thread\/INFO\]: You whispered to (\w+): (.+)/;

    let wMatch = text.match(whisperRegex1) || text.match(whisperRegex2);
    let from = '', to = '', msg = '';
    if (wMatch) {
        from = wMatch[1]; to = wMatch[2]; msg = wMatch[3];
    } else {
        wMatch = text.match(whisperRegex3);
        if (wMatch) {
            from = '服务端'; to = wMatch[1]; msg = wMatch[2];
        }
    }
    if (wMatch) {
        const wLine = document.createElement('div');
        wLine.style.marginBottom = '5px';
        wLine.style.padding = '3px 5px';
        wLine.style.borderLeft = '2px solid #ff00ff';
        wLine.style.background = 'rgba(255, 0, 255, 0.05)';
        const labelSpan = document.createElement('span');
        labelSpan.style.color = '#ff99ff';
        labelSpan.style.fontSize = '12px';
        labelSpan.textContent = `[私信] ${from} -> ${to}: `;
        const contentSpan = document.createElement('span');
        contentSpan.textContent = msg;
        contentSpan.style.color = '#eee';
        wLine.appendChild(labelSpan);
        wLine.appendChild(contentSpan);
        chatContainer.appendChild(wLine);
        chatContainer.scrollTop = chatContainer.scrollHeight;
        if (chatContainer.childNodes.length > 200) {
            chatContainer.removeChild(chatContainer.firstChild);
        }
    }
}

socket.on('players-update', (players) => {
    g_onlinePlayersList = players;
    playerCountEl.textContent = players.length;
    playerListEl.innerHTML = '';
    players.forEach(player => {
        const li = document.createElement('li');
        li.onclick = (e) => {
            if (e.target.tagName !== 'BUTTON') openPrivateMsg(player);
        };
        li.title = `点击与 ${player} 进行私信`;
        const infoDiv = document.createElement('div');
        infoDiv.className = 'player-info';
        infoDiv.textContent = player;
        infoDiv.style.fontWeight = 'bold';
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'player-actions';
        const btnKick = document.createElement('button');
        btnKick.className = 'btn-kick';
        btnKick.textContent = '踢出';
        btnKick.onclick = (e) => {
            e.stopPropagation();
            confirmAction('踢出', player, () => socket.emit('kick-player', player));
        };
        actionsDiv.appendChild(btnKick);
        li.appendChild(infoDiv);
        li.appendChild(actionsDiv);
        playerListEl.appendChild(li);
    });
});

socket.on('all-players', (players) => {
    g_allPlayers = players;
    renderAllPlayers();
});

socket.on('banned-list', (banned) => {
    g_bannedPlayers = banned;
    renderAllPlayers();
});

socket.on('ops-list', (ops) => {
    g_opsPlayers = ops;
    renderAllPlayers(); 
});

socket.on('whitelist-list', (wl) => {
    g_whitelistPlayers = wl;
    renderAllPlayers(); 
});

socket.on('usage-update', (stats) => {
    valCpu.textContent = stats.cpu;
    valMem.textContent = stats.mem;
    valRx.textContent = stats.rx;
    valTx.textContent = stats.tx;
    if (cpuBar) cpuBar.style.width = stats.cpu + '%';
    if (memBar && stats.memTotal) {
        const memPercent = (parseFloat(stats.mem) / parseFloat(stats.memTotal)) * 100;
        memBar.style.width = memPercent + '%';
    }
    if (statusChart) {
        chartData.cpu.push(parseFloat(stats.cpu));
        chartData.cpu.shift();
        chartData.ram.push(parseFloat(stats.mem));
        chartData.ram.shift();
        statusChart.update();
    }
});

socket.on('status', (status) => {
    if (status === 'running') {
        statusBadge.textContent = 'Running';
        statusBadge.className = 'status-badge status-running';
        btnStart.disabled = true;
        btnStop.disabled = false;
    } else {
        statusBadge.textContent = 'Stopped';
        statusBadge.className = 'status-badge status-stopped';
        btnStart.disabled = false;
        btnStop.disabled = true;
    }
});

const GAMERULE_DEFS = {
    'announceAdvancements': { desc: '在聊天框显示进度达成', type: 'bool' },
    'commandBlockOutput': { desc: '命令方块执行时在聊天框提示', type: 'bool' },
    'disableElytraMovementCheck': { desc: '禁用鞘翅移动检查(防误判)', type: 'bool' },
    'disableRaids': { desc: '禁用袭击(灾厄村民)', type: 'bool' },
    'doDaylightCycle': { desc: '启用昼夜循环', type: 'bool' },
    'doEntityDrops': { desc: '非生物实体掉落物品(如矿车)', type: 'bool' },
    'doFireTick': { desc: '火焰蔓延', type: 'bool' },
    'doInsomnia': { desc: '幻翼生成', type: 'bool' },
    'doImmediateRespawn': { desc: '立即重生(不显示死亡界面)', type: 'bool' },
    'doLimitedCrafting': { desc: '限制合成(仅解锁配方)', type: 'bool' },
    'doMobLoot': { desc: '生物死亡掉落物品', type: 'bool' },
    'doMobSpawning': { desc: '生物自然生成', type: 'bool' },
    'doPatrolSpawning': { desc: '巡逻队生成', type: 'bool' },
    'doTileDrops': { desc: '方块被破坏时掉落物品', type: 'bool' },
    'doTraderSpawning': { desc: '流浪商人生成', type: 'bool' },
    'doVinesSpread': { desc: '藤蔓生长', type: 'bool' },
    'doWeatherCycle': { desc: '天气循环', type: 'bool' },
    'doWardenSpawning': { desc: '监守者生成', type: 'bool' },
    'drowningDamage': { desc: '溺水伤害', type: 'bool' },
    'fallDamage': { desc: '摔落伤害', type: 'bool' },
    'fireDamage': { desc: '火焰/岩浆伤害', type: 'bool' },
    'forgivingVoid': { desc: '虚空不掉落(仅玩家)', type: 'bool' },
    'freezeDamage': { desc: '细雪冻伤', type: 'bool' },
    'keepInventory': { desc: '死亡不掉落', type: 'bool' },
    'logAdminCommands': { desc: '记录管理员日志', type: 'bool' },
    'mobGriefing': { desc: '生物破坏方块(爬行者炸坑)', type: 'bool' },
    'naturalRegeneration': { desc: '玩家自然回血', type: 'bool' },
    'reducedDebugInfo': { desc: '减少F3调试信息', type: 'bool' },
    'sendCommandFeedback': { desc: '显示命令执行反馈', type: 'bool' },
    'showDeathMessages': { desc: '显示死亡信息', type: 'bool' },
    'spectatorsGenerateChunks': { desc: '旁观者加载区块', type: 'bool' },
    'universalAnger': { desc: '中立生物被激怒后攻击附近所有玩家', type: 'bool' },
    'maxCommandChainLength': { desc: '命令链执行最大长度', type: 'int' },
    'maxEntityCramming': { desc: '实体挤压上限(0为无)', type: 'int' },
    'playersSleepingPercentage': { desc: '跳过夜晚所需的睡眠比例(%)', type: 'int' },
    'randomTickSpeed': { desc: '随机刻速率(默认3)', type: 'int' },
    'spawnRadius': { desc: '出生点保护半径', type: 'int' }
};

function renderGameRules() {
    const listEl = document.getElementById('gamerules-list');
    listEl.innerHTML = '';
    Object.keys(GAMERULE_DEFS).sort().forEach(key => {
        const def = GAMERULE_DEFS[key];
        const itemDiv = document.createElement('div');
        itemDiv.className = 'feature-item';
        const textContainer = document.createElement('div');
        textContainer.style.display = 'flex';
        textContainer.style.flexDirection = 'column';
        textContainer.style.flex = '1';
        const label = document.createElement('span');
        label.className = 'feature-name';
        label.textContent = key;
        textContainer.appendChild(label);
        const desc = document.createElement('span');
        desc.style.fontSize = '12px'; desc.style.color = '#888';
        desc.textContent = def.desc;
        textContainer.appendChild(desc);
        let controlEl;
        if (def.type === 'bool') {
            const switchLabel = document.createElement('label');
            switchLabel.className = 'switch';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.id = `gr-input-${key}`;
            input.onchange = () => updateGameRule(key, input.checked);
            const slider = document.createElement('span');
            slider.className = 'slider';
            switchLabel.appendChild(input);
            switchLabel.appendChild(slider);
            controlEl = switchLabel;
        } else {
            const input = document.createElement('input');
            input.type = 'number';
            input.style.padding = '5px';
            input.style.width = '80px';
            input.style.background = '#444';
            input.style.color = 'white';
            input.style.border = '1px solid #555';
            input.style.borderRadius = '3px';
            input.id = `gr-input-${key}`;
            input.onblur = () => updateGameRule(key, input.value);
            controlEl = input;
        }
        itemDiv.appendChild(textContainer);
        itemDiv.appendChild(controlEl);
        listEl.appendChild(itemDiv);
    });
}

socket.on('gamerule-value', (data) => {
    const { key, value } = data;
    const input = document.getElementById(`gr-input-${key}`);
    if (!input) return;
    const def = GAMERULE_DEFS[key];
    if (def && def.type === 'bool') {
        input.checked = (value.toLowerCase() === 'true');
    } else {
        input.value = value;
    }
});

socket.on('server-properties', (props) => {
    const listEl = document.getElementById('features-list');
    listEl.innerHTML = '';
    const keyDescriptions = {
        'accepts-transfers': '接受服务器转移', 'allow-flight': '允许玩家飞行', 'allow-nether': '允许进入下界(地狱)',
        'broadcast-console-to-ops': '向OP广播后台日志', 'broadcast-rcon-to-ops': '向OP广播RCON日志', 'enable-command-block': '启用命令方块',
        'enable-jmx-monitoring': '启用JMX监控', 'enable-query': '启用Query协议', 'enable-rcon': '启用RCON远程控制',
        'enable-status': '在服务器列表显示状态', 'enforce-secure-profile': '强制安全配置文件', 'enforce-whitelist': '强制白名单',
        'force-gamemode': '强制使用默认游戏模式', 'generate-structures': '生成结构(村庄/遗迹)', 'hardcore': '极限模式(死后被ban)',
        'hide-online-players': '隐藏在线玩家列表', 'log-ips': '日志记录玩家IP', 'online-mode': '正版验证(在线模式)',
        'prevent-proxy-connections': '禁止代理连接', 'pvp': '允许玩家对战(PVP)', 'require-resource-pack': '强制使用资源包',
        'spawn-animals': '生成动物', 'spawn-monsters': '生成怪物', 'spawn-npcs': '生成村民(NPC)', 'snooper-enabled': '启用数据采集',
        'sync-chunk-writes': '同步区块写入', 'use-native-transport': '使用原生传输优化', 'white-list': '启用白名单', 'debug': '调试模式',
        'difficulty': '游戏难度', 'gamemode': '默认游戏模式', 'level-name': '世界名称(文件夹名)', 'level-seed': '世界种子',
        'level-type': '世界生成类型', 'max-players': '最大玩家数量', 'server-port': '服务器端口', 'view-distance': '视距(区块)',
        'simulation-distance': '模拟距离(区块)', 'max-tick-time': '最大每刻时间(ms)', 'rate-limit': '数据包速率限制',
        'op-permission-level': 'OP权限等级', 'function-permission-level': '函数执行权限等级', 'network-compression-threshold': '网络压缩阈值',
        'resource-pack': '资源包地址', 'motd': '服务器标语'
    };
    const knownEnums = {
        'difficulty': ['peaceful', 'easy', 'normal', 'hard'],
        'gamemode': ['survival', 'creative', 'adventure', 'spectator'],
        'op-permission-level': ['1', '2', '3', '4'],
        'function-permission-level': ['1', '2', '3', '4']
    };

    if (props['motd'] !== undefined) {
        const itemDiv = document.createElement('div');
        itemDiv.className = 'feature-item';
        const textContainer = document.createElement('div');
        textContainer.style.display = 'flex';
        textContainer.style.flexDirection = 'column';
        const label = document.createElement('span');
        label.className = 'feature-name';
        label.textContent = 'motd';
        textContainer.appendChild(label);
        const desc = document.createElement('span');
        desc.style.fontSize = '12px'; desc.style.color = '#888';
        desc.textContent = keyDescriptions['motd'] || '服务器标语';
        textContainer.appendChild(desc);
        const editBtn = document.createElement('button');
        editBtn.textContent = '编辑';
        editBtn.style.padding = "5px 10px"; editBtn.style.cursor = "pointer"; editBtn.style.background = "#2196F3";
        editBtn.style.color = "white"; editBtn.style.border = "none"; editBtn.style.borderRadius = "4px";
        editBtn.onclick = () => openMotdEditor(props['motd']);
        itemDiv.appendChild(textContainer);
        itemDiv.appendChild(editBtn);
        listEl.appendChild(itemDiv);
    }

    Object.keys(props).sort().forEach(key => {
        if (key === 'motd') return;
        const val = props[key];
        const itemDiv = document.createElement('div');
        itemDiv.className = 'feature-item';
        const textContainer = document.createElement('div');
        textContainer.style.display = 'flex'; textContainer.style.flexDirection = 'column'; textContainer.style.flex = '1';
        const label = document.createElement('span');
        label.className = 'feature-name'; label.textContent = key;
        textContainer.appendChild(label);
        if (keyDescriptions[key]) {
            const desc = document.createElement('span');
            desc.style.fontSize = '12px'; desc.style.color = '#888';
            desc.textContent = keyDescriptions[key];
            textContainer.appendChild(desc);
        }
        let controlEl;
        if (val === 'true' || val === 'false') {
            const switchLabel = document.createElement('label');
            switchLabel.className = 'switch';
            const input = document.createElement('input');
            input.type = 'checkbox'; input.checked = (val === 'true');
            input.onchange = () => toggleProperty(key, input);
            const slider = document.createElement('span');
            slider.className = 'slider';
            switchLabel.appendChild(input); switchLabel.appendChild(slider);
            controlEl = switchLabel;
        } else if (knownEnums[key]) {
            const select = document.createElement('select');
            select.style.padding = '5px'; select.style.background = '#444'; select.style.color = 'white';
            select.style.border = '1px solid #555'; select.style.borderRadius = '3px';
            knownEnums[key].forEach(opt => {
                const option = document.createElement('option');
                option.value = opt; option.textContent = opt;
                if (val === opt) option.selected = true;
                select.appendChild(option);
            });
            select.onchange = () => updateProperty(key, select.value);
            controlEl = select;
        } else {
            const input = document.createElement('input');
            input.type = 'text'; input.value = val;
            input.style.padding = '5px'; input.style.width = '120px'; input.style.background = '#444';
            input.style.color = 'white'; input.style.border = '1px solid #555'; input.style.borderRadius = '3px';
            input.onblur = () => { if (input.value !== val) updateProperty(key, input.value); };
            controlEl = input;
        }
        itemDiv.appendChild(textContainer);
        itemDiv.appendChild(controlEl);
        listEl.appendChild(itemDiv);
    });
});

function backupWorld() {
    if (confirm('确定要立即备份世界吗？这将在后台创建一个压缩包。')) {
        const btn = event.currentTarget;
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = '📦 正在备份...';
        socket.emit('backup-world');
        socket.once('backup-finished', (res) => {
            btn.disabled = false; btn.textContent = originalText;
            if (res.success) {
                if (confirm(`备份成功 (${res.size} MB)！是否立即下载？\n文件名: ${res.filename}`)) {
                    const a = document.createElement('a'); a.href = res.url; a.download = res.filename;
                    document.body.appendChild(a); a.click(); document.body.removeChild(a);
                }
            } else { alert('备份失败: ' + res.error); }
        });
    }
}

function cleanItems() {
    if (confirm('确定要清理地上所有的掉落物吗？')) {
        socket.emit('clean-items');
    }
}

function handleIconUpload(input) {
    const file = input.files[0];
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        const img = new Image();
        img.onload = function() {
            const canvas = document.createElement('canvas');
            canvas.width = 64; canvas.height = 64;
            canvas.getContext('2d').drawImage(img, 0, 0, 64, 64);
            socket.emit('update-server-icon', canvas.toDataURL('image/png'));
            alert('图标已发送，正在处理中... (生效需重启服务器)');
            input.value = '';
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

function openMods() {
    const listEl = document.getElementById('mods-list');
    listEl.innerHTML = '<div style="text-align: center; padding: 20px;">加载中...</div>';
    document.getElementById('mods-overlay').style.display = 'flex';
    socket.emit('get-mods');
}

function closeMods() {
    document.getElementById('mods-overlay').style.display = 'none';
}

function uploadMod(input) {
    const file = input.files[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.jar')) {
        alert('请选择 .jar 格式的模组文件');
        return;
    }

    const formData = new FormData();
    formData.append('mod', file);

    const btn = document.querySelector('button[onclick*="mod-upload-input"]');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '正在上传...';

    fetch('/upload-mod', {
        method: 'POST',
        body: formData
    })
    .then(res => res.json())
    .then(data => {
        btn.disabled = false;
        btn.textContent = originalText;
        input.value = '';
        if (data.success) {
            alert('模组上传成功，重启服务器后生效');
            socket.emit('get-mods');
        } else {
            alert('上传失败: ' + (data.error || '未知错误'));
        }
    })
    .catch(err => {
        btn.disabled = false;
        btn.textContent = originalText;
        alert('上传出错: ' + err.message);
    });
}

function openResourcePacks() {
    document.getElementById('rp-overlay').style.display = 'flex';
    socket.emit('get-resource-packs');
}

function closeResourcePacks() {
    document.getElementById('rp-overlay').style.display = 'none';
}

function uploadResourcePack(input) {
    const file = input.files[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.zip')) {
        alert('请选择 .zip 格式的资源包');
        return;
    }

    const formData = new FormData();
    formData.append('resourcepack', file);

    const btn = document.querySelector('button[onclick*="rp-upload-input"]');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '正在上传...';

    fetch('/upload-resource-pack', {
        method: 'POST',
        body: formData
    })
    .then(res => res.json())
    .then(data => {
        btn.disabled = false;
        btn.textContent = originalText;
        input.value = '';
        if (data.success) {
            alert('上传成功');
            socket.emit('get-resource-packs');
        } else {
            alert('上传失败: ' + (data.error || '未知错误'));
        }
    })
    .catch(err => {
        btn.disabled = false;
        btn.textContent = originalText;
        alert('上传出错: ' + err.message);
    });
}

socket.on('resource-packs-list', (files) => {
    const listEl = document.getElementById('rp-list');
    listEl.innerHTML = files.length === 0 ? '<div style="text-align:center; padding:20px;">资源包文件夹为空</div>' : '';
    
    files.sort().forEach(filename => {
        const itemDiv = document.createElement('div');
        itemDiv.className = 'feature-item';
        itemDiv.style.display = 'flex';
        itemDiv.style.justifyContent = 'space-between';
        itemDiv.style.alignItems = 'center';
        itemDiv.style.padding = '10px';
        
        const nameSpan = document.createElement('span');
        nameSpan.style.fontSize = '13px';
        nameSpan.textContent = filename;
        nameSpan.style.flex = '1';
        nameSpan.style.marginRight = '10px';
        nameSpan.style.overflow = 'hidden';
        nameSpan.style.textOverflow = 'ellipsis';
        nameSpan.style.whiteSpace = 'nowrap';
        
        const actionsDiv = document.createElement('div');
        actionsDiv.style.display = 'flex';
        actionsDiv.style.gap = '8px';
        actionsDiv.style.alignItems = 'center';
        
        const applyBtn = document.createElement('button');
        applyBtn.className = 'menu-btn';
        applyBtn.style.margin = '0';
        applyBtn.style.padding = '4px 10px';
        applyBtn.style.fontSize = '12px';
        applyBtn.style.background = '#007ACC';
        applyBtn.style.borderColor = '#007ACC';
        applyBtn.textContent = '应用';
        applyBtn.onclick = () => {
            if (confirm(`确定要将 ${filename} 设置为服务器资源包吗？`)) {
                socket.emit('apply-resource-pack', { filename, host: window.location.host });
            }
        };
        
        const delBtn = document.createElement('button');
        delBtn.innerHTML = '🗑️';
        delBtn.style.background = 'none';
        delBtn.style.border = 'none';
        delBtn.style.cursor = 'pointer';
        delBtn.style.fontSize = '16px';
        delBtn.style.display = 'flex';
        delBtn.style.alignItems = 'center';
        delBtn.onclick = () => {
            if (confirm(`确定要删除 ${filename} 吗？`)) {
                socket.emit('delete-resource-pack', filename);
            }
        };
        
        actionsDiv.appendChild(applyBtn);
        actionsDiv.appendChild(delBtn);
        itemDiv.appendChild(nameSpan);
        itemDiv.appendChild(actionsDiv);
        listEl.appendChild(itemDiv);
    });
});

socket.on('mods-list-error', (msg) => {
    document.getElementById('mods-list').innerHTML = `<div style="text-align:center; padding:20px; color:#f44336;">${msg}</div>`;
});

socket.on('mods-list', (mods) => {
    const listEl = document.getElementById('mods-list');
    listEl.innerHTML = mods.length === 0 ? '<div style="text-align:center; padding:20px;">mods 文件夹为空</div>' : '';
    mods.sort((a, b) => a.name.localeCompare(b.name)).forEach(mod => {
        const itemDiv = document.createElement('div');
        itemDiv.className = 'feature-item';
        itemDiv.style.display = 'flex'; itemDiv.style.justifyContent = 'space-between'; itemDiv.style.alignItems = 'center';
        const nameContainer = document.createElement('div');
        nameContainer.style.flex = '1'; nameContainer.style.overflow = 'hidden';
        const nameSpan = document.createElement('div');
        nameSpan.style.fontSize = '13px'; nameSpan.style.fontWeight = mod.enabled ? 'bold' : 'normal';
        nameSpan.style.color = mod.enabled ? '#fff' : '#888'; nameSpan.textContent = mod.name;
        nameSpan.style.textOverflow = 'ellipsis'; nameSpan.style.whiteSpace = 'nowrap'; nameSpan.style.overflow = 'hidden';
        nameContainer.appendChild(nameSpan);
        const actionsDiv = document.createElement('div');
        actionsDiv.style.display = 'flex'; actionsDiv.style.gap = '10px'; actionsDiv.style.alignItems = 'center';
        const switchLabel = document.createElement('label');
        switchLabel.className = 'switch';
        const input = document.createElement('input');
        input.type = 'checkbox'; input.checked = mod.enabled;
        input.onchange = () => { socket.emit('toggle-mod', { name: mod.name, enabled: input.checked }); setTimeout(() => socket.emit('get-mods'), 500); };
        const slider = document.createElement('span'); slider.className = 'slider';
        switchLabel.appendChild(input); switchLabel.appendChild(slider);
        const delBtn = document.createElement('button');
        delBtn.innerHTML = '🗑️'; delBtn.style.background = 'none'; delBtn.style.border = 'none'; delBtn.style.cursor = 'pointer'; delBtn.style.fontSize = '16px';
        delBtn.onclick = () => { if (confirm(`确定要永久删除模组 ${mod.name} 吗？`)) { socket.emit('delete-mod', mod.name); setTimeout(() => socket.emit('get-mods'), 500); } };
        actionsDiv.appendChild(switchLabel); actionsDiv.appendChild(delBtn);
        itemDiv.appendChild(nameContainer); itemDiv.appendChild(actionsDiv);
        listEl.appendChild(itemDiv);
    });
});

function startServer() {
    btnStart.disabled = btnStop.disabled = true;
    socket.emit('start-server');
}

function stopServer() {
    btnStart.disabled = btnStop.disabled = true;
    socket.emit('stop-server');
}

function sendCommand() {
    let cmd = cmdInput.value.trim();
    if (cmd) {
        if (currentConsoleTab === 'chat' && !cmd.startsWith('/')) cmd = `/me (网页用户) ${cmd}`;
        socket.emit('send-command', cmd);
        cmdInput.value = '';
    }
}

function handleEnter(e) {
    if (e.key === 'Enter') sendCommand();
}
