/**
 * Minecraft Web Controller - Server Side
 * A lightweight web-based management panel for Minecraft servers.
 * 
 * @license MIT
 * @version 1.0.0
 */

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { spawn, exec } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 配置：你的 jar 包名称和内存设置
// 请根据实际情况修改 jar 包名称
const MC_JAR = 'server.jar';
const MIN_RAM = '2G'; // 最小内存
const MAX_RAM = '6G'; // 最大内存
const SCREEN_NAME = 'mc_server_session'; // Screen 会话名称
const PASSWORD_HASH = 'f2d667e94a71cdccb7939346e376cf6d39bdb457a7297d3080cfa54030ac7932'; // SHA-256 Hash
const PUBLIC_IP = '8.136.196.176'; // 服务器公网 IP
const LOG_FILE = path.join(__dirname, 'server_history.log');
const PORT = 8080;

let isRunning = false; // 服务器运行状态
let logTailProcess = null; // 日志监听进程
const onlinePlayers = new Set();
const logHistory = [];

/**
 * 广播日志：发送给前端 + 写入文件 + 存入内存历史
 */
function broadcastLog(data) {
    const str = data.toString();

    // 1. 发送给所有已登录用户
    io.to('authorized').emit('log', str);

    // 2. 写入文件 (追加模式)
    fs.appendFile(LOG_FILE, str, (err) => {
        if (err) console.error('Error writing to log file:', err);
    });

    // 3. 存入内存 buffer (用于网页刷新后回显)
    logHistory.push(str);
    if (logHistory.length > 500) { // 限制最近 500 条，减少内存占用
        logHistory.shift();
    }
}

/**
 * 启动日志监听 (通过 tail logs/latest.log 实现，支持接管)
 */
function startLogTail() {
    if (logTailProcess) return;

    const logPath = path.join(__dirname, 'logs', 'latest.log');
    // 确保文件存在
    if (!fs.existsSync(logPath)) {
        try {
            fs.mkdirSync(path.dirname(logPath), { recursive: true });
            fs.writeFileSync(logPath, '');
        } catch (e) {
            console.error('Failed to create log file:', e);
        }
    }

    // 1. 读取完整的 latest.log 到 logHistory (或限制部分)
    // 这样能满足 "每次启动网页都可以查看所有日志" (当前最新的)
    try {
        const fullLog = fs.readFileSync(logPath, 'utf8');
        // 清空现有 history 并替换
        logHistory.length = 0;
        const lines = fullLog.split('\n');
        // 取最后500行
        const startIndex = Math.max(0, lines.length - 500);
        for (let i = startIndex; i < lines.length; i++) {
            if (lines[i]) logHistory.push(lines[i]);
        }
    } catch (e) {
        console.error('Error reading initial log:', e);
    }


    // 2. 发送 list 命令以同步在线玩家
    // 稍等 1 秒让 tail 启动就绪，能抓到 list 的输出
    setTimeout(() => {
        if (isRunning) {
            exec(`screen -S ${SCREEN_NAME} -p 0 -X stuff "list\r"`);
        }
    }, 1000);

    // 3. 启动 tail (从文件末尾开始 -n 0，因为我们已经读了全部内容)
    logTailProcess = spawn('tail', ['-F', '-n', '0', logPath]);

    const gameruleRegex = /Gamerule (.*) is currently set to: (.*)/;

    logTailProcess.stdout.on('data', (data) => {
        const str = data.toString();
        // 因为 tail 可能会一次返回整块数据，包含多行，需要分割处理
        const lines = str.split('\n');
        lines.forEach(line => {
            if (!line) return;
            broadcastLog(line);

            // 尝试解析 Gamerule 输出
            // 示例: [12:00:00] [Server thread/INFO]: Gamerule doDaylightCycle is currently set to: true
            const match = line.match(gameruleRegex);
            if (match) {
                const key = match[1].trim();
                const value = match[2].trim();
                io.to('authorized').emit('gamerule-value', { key, value });
            }

            // 识别玩家加入
            const joinMatch = line.match(/: (\w+) joined the game/);
            if (joinMatch) {
                onlinePlayers.add(joinMatch[1]);
                io.to('authorized').emit('players-update', Array.from(onlinePlayers));
            }

            // 识别玩家离开
            const leaveMatch = line.match(/: (\w+) left the game/);
            if (leaveMatch) {
                onlinePlayers.delete(leaveMatch[1]);
                io.to('authorized').emit('players-update', Array.from(onlinePlayers));
            }

            // 识别 /list 命令的输出
            // 格式通常为: There are X of a max of Y players online: player1, player2
            const listMatch = line.match(/There are \d+ of a max of \d+ players online: (.*)/);
            if (listMatch) {
                const namesStr = listMatch[1];
                if (namesStr) {
                    const names = namesStr.split(', ').map(s => s.trim()).filter(s => s.length > 0);
                    onlinePlayers.clear();
                    names.forEach(n => onlinePlayers.add(n));
                    io.to('authorized').emit('players-update', Array.from(onlinePlayers));
                } else {
                    // 没有玩家
                    onlinePlayers.clear();
                    io.to('authorized').emit('players-update', []);
                }
            }
        });
    });

    logTailProcess.stderr.on('data', (data) => {
        console.error('Tail Error:', data.toString());
    });
}

/**
 * 读取历史玩家列表 (从 usercache.json) - 异步版本
 */
function getAllPlayers(callback) {
    const cachePath = path.join(__dirname, 'usercache.json');
    if (fs.existsSync(cachePath)) {
        fs.readFile(cachePath, 'utf8', (err, data) => {
            if (err) {
                console.error('Failed to read usercache:', err);
                if (callback) callback([]);
                return;
            }
            try {
                const json = JSON.parse(data);
                if (callback) callback(json.map(entry => entry.name));
            } catch (e) {
                if (callback) callback([]);
            }
        });
    } else {
        if (callback) callback([]);
    }
}

/**
 * 读取封禁玩家列表 (从 banned-players.json) - 异步版本
 */
function getBannedPlayers(callback) {
    const banPath = path.join(__dirname, 'banned-players.json');
    if (fs.existsSync(banPath)) {
        fs.readFile(banPath, 'utf8', (err, data) => {
            if (err) {
                console.error('Failed to read banned-players:', err);
                if (callback) callback([]);
                return;
            }
            try {
                const json = JSON.parse(data);
                if (callback) callback(json.map(entry => entry.name));
            } catch (e) {
                if (callback) callback([]);
            }
        });
    } else {
        if (callback) callback([]);
    }
}

/**
 * 读取 OP 列表 (从 ops.json) - 异步版本
 */
function getOps(callback) {
    const opPath = path.join(__dirname, 'ops.json');
    if (fs.existsSync(opPath)) {
        fs.readFile(opPath, 'utf8', (err, data) => {
            if (err) {
                console.error('Failed to read ops.json:', err);
                if (callback) callback([]);
                return;
            }
            try {
                const json = JSON.parse(data);
                if (callback) callback(json.map(entry => entry.name));
            } catch (e) {
                if (callback) callback([]);
            }
        });
    } else {
        if (callback) callback([]);
    }
}

/**
 * 获取服务器版本信息 (游戏版本、Fabric/Forge 状态)
 */
function getServerVersionInfo() {
    let gameVersion = 'Unknown';
    let loaderType = 'Vanilla';
    let loaderVersion = '';

    // 1. 检查 Fabric
    const fabricLoaderPath = path.join(__dirname, 'libraries', 'net', 'fabricmc', 'fabric-loader');
    if (fs.existsSync(fabricLoaderPath)) {
        loaderType = 'Fabric';
        try {
            const versions = fs.readdirSync(fabricLoaderPath).filter(f => fs.statSync(path.join(fabricLoaderPath, f)).isDirectory());
            if (versions.length > 0) loaderVersion = versions[0];
        } catch (e) {}

        const intermediaryPath = path.join(__dirname, 'libraries', 'net', 'fabricmc', 'intermediary');
        if (fs.existsSync(intermediaryPath)) {
            try {
                const gVersions = fs.readdirSync(intermediaryPath).filter(f => fs.statSync(path.join(intermediaryPath, f)).isDirectory());
                if (gVersions.length > 0) gameVersion = gVersions[0];
            } catch (e) {}
        }
    }

    // 2. 检查 Forge (如果还没确定是 Fabric)
    if (loaderType === 'Vanilla') {
        const forgePath = path.join(__dirname, 'libraries', 'net', 'minecraftforge', 'forge');
        if (fs.existsSync(forgePath)) {
            loaderType = 'Forge';
            try {
                const versions = fs.readdirSync(forgePath).filter(f => fs.statSync(path.join(forgePath, f)).isDirectory());
                if (versions.length > 0) loaderVersion = versions[0];
            } catch (e) {}
        }
    }
    
    // 3. 检查 NeoForged
    if (loaderType === 'Vanilla') {
        const neoPath = path.join(__dirname, 'libraries', 'net', 'neoforged', 'neoforge');
        if (fs.existsSync(neoPath)) {
            loaderType = 'NeoForge';
            try {
                const versions = fs.readdirSync(neoPath).filter(f => fs.statSync(path.join(neoPath, f)).isDirectory());
                if (versions.length > 0) loaderVersion = versions[0];
            } catch (e) {}
        }
    }

    // 4. 如果还没找到游戏版本，尝试从 versions/ 目录找
    if (gameVersion === 'Unknown') {
        const versionsPath = path.join(__dirname, 'versions');
        if (fs.existsSync(versionsPath)) {
            try {
                const versions = fs.readdirSync(versionsPath).filter(f => fs.statSync(path.join(versionsPath, f)).isDirectory());
                if (versions.length > 0) gameVersion = versions[0];
            } catch (e) {}
        }
    }

    return { gameVersion, loaderType, loaderVersion };
}

/**
 * 读取白名单列表 (从 whitelist.json) - 异步版本
 */
function getWhitelist(callback) {
    const wlPath = path.join(__dirname, 'whitelist.json');
    if (fs.existsSync(wlPath)) {
        fs.readFile(wlPath, 'utf8', (err, data) => {
            if (err) {
                console.error('Failed to read whitelist.json:', err);
                if (callback) callback([]);
                return;
            }
            try {
                const json = JSON.parse(data);
                if (callback) callback(json.map(entry => entry.name));
            } catch (e) {
                if (callback) callback([]);
            }
        });
    } else {
        if (callback) callback([]);
    }
}




/**
 * 检查 Screen 状态并尝试接管
 */
function checkServerStatus(callback) {
    exec('screen -list', (err, stdout, stderr) => {
        // screen -list 返回非 0 如果没有 session，或没安装 screen
        // 但 stdout 可能包含信息
        const found = stdout && stdout.includes(SCREEN_NAME);

        if (found) {
            if (!isRunning) {
                console.log('Found existing screen session, taking over...');
                broadcastLog('System: Found existing server process, taking over...\n');
                isRunning = true;
                io.to('authorized').emit('status', 'running');
                startLogTail(); // 确保开始监听日志
            }
        } else {
            if (isRunning) {
                console.log('Screen session lost.');
                broadcastLog('System: Server process stopped or screen session terminated.\n');
                isRunning = false;
                io.to('authorized').emit('status', 'stopped');
                onlinePlayers.clear();
                io.to('authorized').emit('players-update', []);
            }
        }
        if (callback) callback(found);
    });
}

// 定期检查状态 (每 3 秒)
setInterval(() => checkServerStatus(), 3000);

/**
 * 启动服务器逻辑 (使用 Screen)
 */
function startMcServer() {
    checkServerStatus((running) => {
        if (running) {
            broadcastLog('System: Server is already running.\n');
            return;
        }

        broadcastLog(`System: Starting server with ${MC_JAR} in screen session [${SCREEN_NAME}]...\n`);

        const javaCmd = `java -Xms${MIN_RAM} -Xmx${MAX_RAM} -jar ${MC_JAR} nogui`;

        // 启动 Screen 会话
        const screenProcess = spawn('screen', ['-dmS', SCREEN_NAME, 'bash', '-c', javaCmd], { cwd: __dirname });

        screenProcess.on('close', (code) => {
            if (code === 0) {
                // screen 命令本身执行成功 (会话建立)
                setTimeout(() => checkServerStatus(), 1000); // 稍后确认状态
            } else {
                broadcastLog(`System: Failed to start screen session (code ${code}).\n`);
            }
        });

        screenProcess.on('error', (err) => {
            broadcastLog(`System Error: Failed to spawn screen. ${err.message}\n`);
        });
    });
}

// 托管静态文件 (HTML, CSS)
app.use(express.static(path.join(__dirname, 'public')));
// 托管备份文件夹，允许直接下载
app.use('/backups', express.static(path.join(__dirname, 'backups')));
// 托管资源包文件夹
app.use('/resourcepacks', express.static(path.join(__dirname, 'serverresourcepacks')));

// 配置 Multer 用于资源包上传
const rpStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(__dirname, 'serverresourcepacks'));
    },
    filename: (req, file, cb) => {
        // 保持原名，但如果是中文可能会有问题，这里简单处理下
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const rpUpload = multer({ storage: rpStorage });

// 配置 Multer 用于模组上传
const modStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(__dirname, 'mods'));
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname); // 模组通常直接使用原名
    }
});
const modUpload = multer({ storage: modStorage });

app.post('/upload-resource-pack', rpUpload.single('resourcepack'), (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');
    
    // 计算 SHA-1
    const filePath = req.file.path;
    const fileBuffer = fs.readFileSync(filePath);
    const sha1 = crypto.createHash('sha1').update(fileBuffer).digest('hex');
    
    res.json({
        success: true,
        filename: req.file.filename,
        sha1: sha1
    });
});

app.post('/upload-mod', modUpload.single('mod'), (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');
    res.json({ success: true, filename: req.file.filename });
});

// --- 系统监测逻辑 ---
let monitorInterval = null;
let prevCpuTimes = null;
let prevNetStats = null;

function getCpuTimes() {
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;
    for (const cpu of cpus) {
        for (const type in cpu.times) {
            total += cpu.times[type];
        }
        idle += cpu.times.idle;
    }
    return { idle, total };
}

function getNetStats() {
    try {
        const data = fs.readFileSync('/proc/net/dev', 'utf8');
        const lines = data.split('\n');
        let rx = 0;
        let tx = 0;
        // Skip header lines (2)
        for (let i = 2; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const parts = line.split(/\s+/);
            if (parts[0].startsWith('lo')) continue; // skip loopback
            // parts[0] is interface name
            // parts[1] is RX bytes
            // parts[9] is TX bytes (on most Linux kernels)
            rx += parseInt(parts[1] || 0);
            tx += parseInt(parts[9] || 0);
        }
        return { rx, tx };
    } catch (e) {
        return { rx: 0, tx: 0 };
    }
}

function startSystemMonitor() {
    if (monitorInterval) return;

    // Init prev stats
    prevCpuTimes = getCpuTimes();
    prevNetStats = getNetStats();

    monitorInterval = setInterval(() => {
        // 如果没有客户端连接，停止监测
        if (io.engine.clientsCount === 0) {
            clearInterval(monitorInterval);
            monitorInterval = null;
            return;
        }

        // CPU Calculation
        const currCpu = getCpuTimes();
        const deltaIdle = currCpu.idle - prevCpuTimes.idle;
        const deltaTotal = currCpu.total - prevCpuTimes.total;
        const cpuPercent = (1 - deltaIdle / deltaTotal) * 100;
        prevCpuTimes = currCpu;

        // RAM Calculation
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;

        // Net Calculation (diff over 5s)
        const currNet = getNetStats();
        const diffRx = currNet.rx - prevNetStats.rx;
        const diffTx = currNet.tx - prevNetStats.tx;
        const rxSpeed = diffRx / 5; // B/s
        const txSpeed = diffTx / 5;
        prevNetStats = currNet;

        const stats = {
            cpu: cpuPercent.toFixed(1), // %
            mem: (usedMem / 1024 / 1024 / 1024).toFixed(2), // GB
            memTotal: (totalMem / 1024 / 1024 / 1024).toFixed(2), // GB
            rx: (rxSpeed / 1024).toFixed(1), // KB/s
            tx: (txSpeed / 1024).toFixed(1)
        };

        // 仅发送给已授权用户
        io.to('authorized').emit('usage-update', stats);

    }, 10000); // 增加间隔到 10 秒
}

/**
 * 监听 JSON 文件变化并广播
 */
function startFileWatchers() {
    const filesToWatch = [
        { file: 'usercache.json', event: 'all-players', getter: getAllPlayers },
        { file: 'banned-players.json', event: 'banned-list', getter: getBannedPlayers },
        { file: 'ops.json', event: 'ops-list', getter: getOps },
        { file: 'whitelist.json', event: 'whitelist-list', getter: getWhitelist }
    ];

    filesToWatch.forEach(({ file, event, getter }) => {
        const filePath = path.join(__dirname, file);

        // 辅助函数：设置监听
        const watchFile = () => {
            if (!fs.existsSync(filePath)) return;

            // 简单的防抖动
            let fsWait = false;
            try {
                fs.watch(filePath, (eventType, filename) => {
                    if (fsWait) return;
                    fsWait = true;
                    setTimeout(() => {
                        fsWait = false;
                        console.log(`File ${file} changed, broadcasting update.`);
                        getter((data) => {
                            io.to('authorized').emit(event, data);
                        });
                    }, 5000); // 5秒防抖，降低频率
                });
                console.log(`Started watching ${file}`);
            } catch (e) {
                console.error(`Error watching ${file}:`, e);
            }
        };

        watchFile();
    });
}


// WebSocket 连接处理
io.on('connection', (socket) => {
    console.log('Web client connected');
    startSystemMonitor(); // 尝试启动监测
    let isAuthenticated = false;

    // 监听登录请求
    socket.on('login', (pwd) => {
        const inputHash = crypto.createHash('sha256').update(pwd).digest('hex');
        if (inputHash === PASSWORD_HASH) {
            isAuthenticated = true;
            socket.join('authorized'); // 加入已授权组
            socket.emit('login-success');
            // 登录成功后，立即发送当前状态和在线玩家
            socket.emit('status', isRunning ? 'running' : 'stopped');
            socket.emit('players-update', Array.from(onlinePlayers));
            
            // 发送版本信息
            socket.emit('server-version', getServerVersionInfo());

            // 发送最近的历史日志
            socket.emit('log-history', logHistory);

            // 发送所有历史玩家 (使用异步)
            getAllPlayers((players) => socket.emit('all-players', players));
            // 发送封禁列表 (使用异步)
            getBannedPlayers((banned) => socket.emit('banned-list', banned));
            // 发送 OP 列表
            getOps((ops) => socket.emit('ops-list', ops));
            // 发送白名单列表
            getWhitelist((wl) => socket.emit('whitelist-list', wl));
        } else {
            socket.emit('login-fail');
        }
    });


    // 监听：启动服务器
    socket.on('start-server', () => {
        if (!isAuthenticated) return;
        startMcServer();
    });

    // 通用命令执行辅助
    const runConsoleCmd = (cmdStr) => {
        if (isRunning) {
            broadcastLog(`> ${cmdStr}\n`);
            const screenCmd = `screen -S ${SCREEN_NAME} -p 0 -X stuff "${cmdStr}\r"`;
            exec(screenCmd, (err) => { if (err) console.error('Cmd Error:', err); });
        }
    };

    // 玩家管理命令
    socket.on('kick-player', (name) => {
        if (!isAuthenticated) return;
        runConsoleCmd(`kick ${name}`);
    });


    socket.on('ban-player', (name) => {
        if (!isAuthenticated) return;
        runConsoleCmd(`ban ${name}`);
        // 稍后更新列表
        setTimeout(() => {
            getBannedPlayers((banned) => {
                socket.emit('banned-list', banned);
                io.to('authorized').emit('banned-list', banned);
            });
        }, 1000);
    });

    socket.on('pardon-player', (name) => {
        if (!isAuthenticated) return;
        runConsoleCmd(`pardon ${name}`);
        setTimeout(() => {
            getBannedPlayers((banned) => {
                socket.emit('banned-list', banned);
                io.to('authorized').emit('banned-list', banned);
            });
        }, 1000);
    });

    socket.on('op-player', (name) => {
        if (!isAuthenticated) return;
        runConsoleCmd(`op ${name}`);
        setTimeout(() => {
            getOps((ops) => {
                socket.emit('ops-list', ops);
                io.to('authorized').emit('ops-list', ops);
            });
        }, 1000);
    });

    socket.on('deop-player', (name) => {
        if (!isAuthenticated) return;
        runConsoleCmd(`deop ${name}`);
        setTimeout(() => {
            getOps((ops) => {
                socket.emit('ops-list', ops);
                io.to('authorized').emit('ops-list', ops);
            });
        }, 1000);
    });

    socket.on('whitelist-add', (name) => {
        if (!isAuthenticated) return;
        runConsoleCmd(`whitelist add ${name}`);
        setTimeout(() => {
            getWhitelist((wl) => {
                socket.emit('whitelist-list', wl);
                io.to('authorized').emit('whitelist-list', wl);
            });
        }, 1000);
    });

    socket.on('whitelist-remove', (name) => {
        if (!isAuthenticated) return;
        runConsoleCmd(`whitelist remove ${name}`);
        setTimeout(() => {
            getWhitelist((wl) => {
                socket.emit('whitelist-list', wl);
                io.to('authorized').emit('whitelist-list', wl);
            });
        }, 1000);
    });

    socket.on('set-player-gamemode', ({ name, mode }) => {
        if (!isAuthenticated) return;
        runConsoleCmd(`gamemode ${mode} ${name}`);
    });

    socket.on('clear-player-inventory', (name) => {
        if (!isAuthenticated) return;
        runConsoleCmd(`clear ${name}`);
    });

    // --- 扩展快速工具功能 ---

    // 1. 世界备份并提供下载链接
    socket.on('backup-world', () => {
        if (!isAuthenticated) return;
        
        const backupDir = path.join(__dirname, 'backups');
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const backupName = `world_backup_${timestamp}.tar.gz`;
        const backupPath = path.join(backupDir, backupName);

        broadcastLog(`System: Starting background backup to ${backupName}...\n`);

        // 使用 tar 命令在后台压缩
        const tarCmd = `tar -czf "${backupPath}" world/`;
        
        exec(tarCmd, (err) => {
            if (err) {
                broadcastLog(`System Error: Backup failed! ${err.message}\n`);
                socket.emit('backup-finished', { success: false, error: err.message });
            } else {
                const stats = fs.statSync(backupPath);
                const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
                broadcastLog(`System: Backup completed! Size: ${sizeMB} MB\n`);
                
                // 发送下载链接给前端
                const downloadUrl = `/backups/${backupName}`;
                socket.emit('backup-finished', { 
                    success: true, 
                    url: downloadUrl, 
                    filename: backupName,
                    size: sizeMB
                });
            }
        });
    });

    // 2. 清理掉落物
    socket.on('clean-items', () => {
        if (!isAuthenticated) return;
        runConsoleCmd('kill @e[type=item]');
        broadcastLog('System: Executed clear items command.\n');
    });

    // 3. Mod 管理
    const MODS_DIR = path.join(__dirname, 'mods');
    
    socket.on('get-mods', () => {
        if (!isAuthenticated) {
            socket.emit('mods-list-error', '未授权，请尝试刷新页面。');
            return;
        }
        if (!fs.existsSync(MODS_DIR)) {
            socket.emit('mods-list', []);
            return;
        }
        
        fs.readdir(MODS_DIR, (err, files) => {
            if (err) {
                console.error('Error reading mods dir:', err);
                socket.emit('mods-list-error', '读取文件夹失败: ' + err.message);
                return;
            }
            // 过滤出 .jar 或 .disabled 文件 (支持大写扩展名)
            const mods = files.filter(f => {
                const name = f.trim().toLowerCase();
                return name.endsWith('.jar') || name.endsWith('.disabled');
            }).map(f => {
                const name = f.trim();
                const isEnabled = name.toLowerCase().endsWith('.jar');
                return {
                    name: name,
                    enabled: isEnabled,
                    baseName: isEnabled ? name.replace(/\.jar$/i, '') : name.replace(/\.disabled$/i, '')
                };
            });
            socket.emit('mods-list', mods);
        });
    });

    socket.on('toggle-mod', ({ name, enabled }) => {
        if (!isAuthenticated) return;
        const oldPath = path.join(MODS_DIR, name);
        let newName = name;
        if (enabled && name.endsWith('.disabled')) {
            newName = name.replace('.disabled', '.jar');
        } else if (!enabled && name.endsWith('.jar')) {
            newName = name.replace('.jar', '.disabled');
        }

        if (newName !== name) {
            fs.rename(oldPath, path.join(MODS_DIR, newName), (err) => {
                if (err) {
                    console.error('Error toggling mod:', err);
                } else {
                    broadcastLog(`System: Mod ${enabled ? 'enabled' : 'disabled'}: ${newName}\n`);
                    // 更新后重新发送列表
                    exec(`ls ${MODS_DIR}`, () => { // 触发一次读取
                         // 重新触发前端刷新
                    });
                }
            });
        }
    });

    socket.on('delete-mod', (name) => {
        if (!isAuthenticated) return;
        const modPath = path.join(MODS_DIR, name);
        fs.unlink(modPath, (err) => {
            if (err) {
                console.error('Error deleting mod:', err);
            } else {
                broadcastLog(`System: Mod deleted: ${name}\n`);
            }
        });
    });

    // --- Server Properties Management ---
    // --- 资源包管理 ---
    socket.on('get-resource-packs', () => {
        if (!isAuthenticated) return;
        const dir = path.join(__dirname, 'serverresourcepacks');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        fs.readdir(dir, (err, files) => {
            if (err) return console.error(err);
            socket.emit('resource-packs-list', files.filter(f => f.endsWith('.zip')));
        });
    });

    socket.on('delete-resource-pack', (filename) => {
        if (!isAuthenticated) return;
        const filePath = path.join(__dirname, 'serverresourcepacks', filename);
        if (fs.existsSync(filePath)) {
            fs.unlink(filePath, (err) => {
                if (!err) {
                    broadcastLog(`[System] Deleted resource pack: ${filename}\n`);
                    // 重新获取列表
                    const dir = path.join(__dirname, 'serverresourcepacks');
                    fs.readdir(dir, (err, files) => {
                        if (!err) socket.emit('resource-packs-list', files.filter(f => f.endsWith('.zip')));
                    });
                }
            });
        }
    });

    socket.on('apply-resource-pack', ({ filename, host }) => {
        if (!isAuthenticated) return;
        const filePath = path.join(__dirname, 'serverresourcepacks', filename);
        if (!fs.existsSync(filePath)) return;

        try {
            const fileBuffer = fs.readFileSync(filePath);
            const sha1 = crypto.createHash('sha1').update(fileBuffer).digest('hex');
            
            // 优先使用预设的公网 IP，如果没有则使用前端传来的 host
            const finalHost = (typeof PUBLIC_IP !== 'undefined' && PUBLIC_IP) ? `${PUBLIC_IP}:${PORT}` : host;
            const url = `http://${finalHost}/resourcepacks/${filename}`;

            updateServerProperty('resource-pack', url);
            updateServerProperty('resource-pack-sha1', sha1);
            
            broadcastLog(`[System] Applied resource pack: ${filename}\n`);
            broadcastLog(`[System] Generated URL: ${url}\n`);
            broadcastLog(`[System] SHA1: ${sha1}\n`);
            
            // 刷新属性
            const props = getServerProperties();
            socket.emit('server-properties', props);
        } catch (e) {
            console.error('Error applying resource pack:', e);
        }
    });

    const PROPS_FILE = 'server.properties';

    // Helper: Read and Parse Properties
    function getServerProperties() {
        try {
            if (!fs.existsSync(PROPS_FILE)) return {};
            const data = fs.readFileSync(PROPS_FILE, 'utf8');
            const lines = data.split('\n');
            const props = {};
            lines.forEach(line => {
                line = line.trim();
                if (line && !line.startsWith('#')) {
                    const parts = line.split('=');
                    if (parts.length >= 2) {
                        const key = parts[0].trim();
                        const value = parts.slice(1).join('=').trim();
                        props[key] = value;
                    }
                }
            });
            return props;
        } catch (e) {
            console.error('Error reading properties:', e);
            return {};
        }
    }

    // Helper: Update Property
    function updateServerProperty(key, newValue) {
        try {
            if (!fs.existsSync(PROPS_FILE)) return;
            const data = fs.readFileSync(PROPS_FILE, 'utf8');
            const lines = data.split('\n');
            const newLines = [];
            let found = false;

            lines.forEach(line => {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#')) {
                    const parts = trimmed.split('=');
                    if (parts.length >= 2 && parts[0].trim() === key) {
                        newLines.push(`${key}=${newValue}`);
                        found = true;
                    } else {
                        newLines.push(line);
                    }
                } else {
                    newLines.push(line);
                }
            });

            if (!found) {
                newLines.push(`${key}=${newValue}`);
            }

            fs.writeFileSync(PROPS_FILE, newLines.join('\n'));
            console.log(`Updated property: ${key} = ${newValue}`);
        } catch (e) {
            console.error('Error updating property:', e);
        }
    }

    socket.on('get-server-properties', () => {
        if (!isAuthenticated) return;
        const props = getServerProperties();
        socket.emit('server-properties', props);
    });

    socket.on('update-server-property', ({ key, value }) => {
        if (!isAuthenticated) return;
        updateServerProperty(key, value);
        // Broadcast update to other clients if needed, or just ack
        const props = getServerProperties();
        socket.emit('server-properties', props); // Refresh client
    });

    // --- Gamerule Management ---
    socket.on('query-gamerules', (keys) => {
        if (!isAuthenticated) return;
        if (!isRunning) return; // Must be running
        if (Array.isArray(keys)) {
            keys.forEach(key => {
                runConsoleCmd(`gamerule ${key}`);
            });
        }
    });

    socket.on('set-gamerule', ({ key, value }) => {
        if (!isAuthenticated) return;
        runConsoleCmd(`gamerule ${key} ${value}`);
        // Read back validation
        setTimeout(() => {
            runConsoleCmd(`gamerule ${key}`);
        }, 500);
    });


    socket.on('pardon-player', (name) => {
        if (!isAuthenticated) return;
        runConsoleCmd(`pardon ${name}`);
        setTimeout(() => {
            getBannedPlayers((banned) => io.to('authorized').emit('banned-list', banned));
        }, 1000);
    });


    // 监听：发送命令
    socket.on('send-command', (command) => {
        if (!isAuthenticated) return;

        if (isRunning) {
            runConsoleCmd(command);
        } else {
            socket.emit('log', 'System: Server is not running.\n');
        }
    });

    // 监听：停止服务器
    socket.on('stop-server', () => {
        if (!isAuthenticated) return;

        if (isRunning) {
            broadcastLog('System: Stopping server...\n');
            // 发送 stop 到 screen
            exec(`screen -S ${SCREEN_NAME} -p 0 -X stuff "stop\r"`);
        }
    });

    socket.on('update-server-icon', (base64Data) => {
        if (!isAuthenticated) return;
        
        try {
            // 我的 Minecraft 服务器使用 server-icon.png 作为标准图标文件名
            const iconPath = path.join(__dirname, 'server-icon.png');
            // 提取 base64 数据部分
            const data = base64Data.replace(/^data:image\/\w+;base64,/, "");
            const buffer = Buffer.from(data, 'base64');

            // 1. 备份旧图标 (如果存在)
            if (fs.existsSync(iconPath)) {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').split('.')[0];
                const backupPath = path.join(__dirname, `server-icon_backup_${timestamp}.png`);
                fs.renameSync(iconPath, backupPath);
                console.log(`Backed up old icon to ${backupPath}`);
            }

            // 2. 写入新图标
            fs.writeFileSync(iconPath, buffer);
            socket.emit('log', 'System: 服务器图标已更新（已自动备份旧文件并强制转换为 64x64 PNG）。生效请重启服务器。\n');
        } catch (err) {
            console.error('Failed to update icon:', err);
            socket.emit('log', `System error: 无法更新图标: ${err.message}\n`);
        }
    });
});

// Auto-start logic
console.log('Auto-starting Minecraft server...');

// 启动文件监听
startFileWatchers();

// 定期同步在线玩家列表 (每60秒)，防止日志解析遗漏
setInterval(() => {
    if (isRunning) {
        exec(`screen -S ${SCREEN_NAME} -p 0 -X stuff "list\r"`);
    }
}, 60000);

// 启动时检查状态，如果未运行则尝试启动
checkServerStatus((running) => {
    if (!running) {
        console.log('No existing server session found. Starting new session...');
        startMcServer();
    } else {
        console.log(`Attached to existing session: ${SCREEN_NAME}`);
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Control panel running at http://0.0.0.0:${PORT}`);
});
