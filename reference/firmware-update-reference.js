const http = require('http');
const fs = require('fs').promises;
const path = require('path');

// Configuration matching the app's exact settings
const CONFIG = {
    DEFAULT_PORT: 8000,
    FIRMWARE_PROCESSING_WAIT: 7000,  // 7 seconds - proven reliable in testing
    SEND_REBOOT_WAIT: 1500,         // 1.5 seconds - proven reliable in testing
    MAIN_BOARD_REBOOT_WAIT: 7000,   // 7 seconds - proven reliable in testing
    REAR_BOARD_REBOOT_WAIT: 20000,  // 20 seconds - needed for rear board
    ENDPOINTS: {
        FIRMWARE_CHARGER: '/api/v2/device/firmware_charger',
        FIRMWARE_REAR: '/api/v2/device/firmware_rear',
        REBOOT: '/api/v2/device/reboot',
        INFO: '/api/v2/device/info'
    }
};

async function findLatestFirmwareFiles() {
    // Look for firmware files in firmware/ directory
    const firmwareDir = path.join(__dirname, '..', 'firmware');
    
    try {
        // Read all files in firmware directory
        const files = await fs.readdir(firmwareDir);
        
        // Find latest main and rear firmware files
        const mainFiles = files.filter(f => f.startsWith('main_') && f.endsWith('.signed.bin'))
                               .sort().reverse(); // Sort descending to get latest first
        const rearFiles = files.filter(f => f.startsWith('rear_') && f.endsWith('.signed.bin'))
                               .sort().reverse(); // Sort descending to get latest first
        
        if (mainFiles.length === 0) {
            throw new Error('No main firmware files found in firmware/ directory');
        }
        if (rearFiles.length === 0) {
            throw new Error('No rear firmware files found in firmware/ directory');
        }
        
        const mainPath = path.join(firmwareDir, mainFiles[0]);
        const rearPath = path.join(firmwareDir, rearFiles[0]);
        
        // Verify files exist and are readable
        await fs.access(mainPath);
        await fs.access(rearPath);
        
        console.log(`[FIRMWARE] Found latest main firmware: ${mainFiles[0]}`);
        console.log(`[FIRMWARE] Found latest rear firmware: ${rearFiles[0]}`);
        
        return {
            main: mainPath,
            rear: rearPath
        };
        
    } catch (error) {
        throw new Error(`Failed to find firmware files: ${error.message}`);
    }
}

async function testDeviceConnection(ip) {
    return new Promise((resolve) => {
        const options = {
            hostname: ip,
            port: CONFIG.DEFAULT_PORT,
            path: CONFIG.ENDPOINTS.INFO,
            method: 'GET',
            timeout: 3000
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const info = JSON.parse(data);
                    const deviceName = info.deviceName || info.name;
                    if (deviceName && deviceName.toLowerCase().includes('klvr')) {
                        resolve({
                            ip: ip,
                            deviceName: deviceName,
                            firmwareVersion: info.firmwareVersion,
                            serialNumber: info.serialNumber || info.ip?.macAddress || 'Unknown'
                        });
                    } else {
                        console.log(`[DISCOVERY] Device at ${ip} has name "${deviceName}" - not a KLVR device`);
                        resolve(null);
                    }
                } catch (error) {
                    console.log(`[DISCOVERY] Failed to parse response from ${ip}: ${error.message}`);
                    resolve(null);
                }
            });
        });

        req.on('error', () => resolve(null));
        req.on('timeout', () => {
            req.destroy();
            resolve(null);
        });

        req.end();
    });
}

async function getDeviceInfo(deviceIp) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: deviceIp,
            port: CONFIG.DEFAULT_PORT,
            path: CONFIG.ENDPOINTS.INFO,
            method: 'GET'
        };

        console.log(`[FIRMWARE] Getting device info from ${deviceIp}...`);

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const info = JSON.parse(data);
                    console.log(`[FIRMWARE] Current firmware version: ${info.firmwareVersion}`);
                    resolve(info);
                } catch (error) {
                    reject(new Error('Failed to parse device info response'));
                }
            });
        });

        req.on('error', (error) => {
            console.error(`[FIRMWARE] Device info error:`, error);
            reject(error);
        });

        req.end();
    });
}

async function uploadFirmware(deviceIp, firmware, isMainBoard) {
    return new Promise((resolve, reject) => {
        const path = isMainBoard ? CONFIG.ENDPOINTS.FIRMWARE_CHARGER : CONFIG.ENDPOINTS.FIRMWARE_REAR;
        const boardType = isMainBoard ? 'main' : 'rear';
        
        const options = {
            hostname: deviceIp,
            port: CONFIG.DEFAULT_PORT,
            path: path,
            method: 'POST',
            headers: {
                'Content-Length': firmware.length
            }
        };

        console.log(`[FIRMWARE] Uploading ${boardType} firmware to: ${deviceIp}, size: ${firmware.length} bytes`);

        const req = http.request(options, (res) => {
            console.log(`[FIRMWARE] Upload response status: ${res.statusCode}`);
            
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
                console.log(`[FIRMWARE] Upload response chunk: ${chunk.toString()}`);
            });
            
            res.on('end', () => {
                console.log(`[FIRMWARE] Upload complete: ${data}`);
                resolve({
                    ok: res.statusCode === 200,
                    status: res.statusCode,
                    statusText: res.statusMessage,
                    data: data
                });
            });
        });

        req.on('error', (error) => {
            console.error(`[FIRMWARE] Upload error:`, error);
            reject(error);
        });

        req.write(firmware);
        req.end();
    });
}

async function rebootDevice(deviceIp, board) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: deviceIp,
            port: CONFIG.DEFAULT_PORT,
            path: `${CONFIG.ENDPOINTS.REBOOT}?board=${board}`,
            method: 'POST',
            headers: {
                'Content-Length': 4  // Length of "main" or "rear" is always 4
            }
        };

        console.log(`[FIRMWARE] Rebooting ${board} board on device: ${deviceIp}`);

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                resolve({
                    ok: res.statusCode === 200,
                    status: res.statusCode,
                    statusText: res.statusMessage,
                    data: data
                });
            });
        });

        req.on('error', (error) => {
            console.error(`[FIRMWARE] Reboot error:`, error);
            reject(error);
        });

        // Send the board type as the body (like in the app)
        req.write(board);
        req.end();
    });
}

async function executeFirmwareUpdate(deviceIp, mainFirmwarePath, rearFirmwarePath) {
    try {
        // 1. Get device info first (like the app does)
        console.log('[FIRMWARE] Getting device info...');
        const deviceInfo = await getDeviceInfo(deviceIp);
        console.log(`[FIRMWARE] Current firmware version: ${deviceInfo.firmwareVersion}`);

        // 2. Read firmware files
        console.log('[FIRMWARE] Reading firmware files...');
        const mainFirmware = await fs.readFile(mainFirmwarePath);
        const rearFirmware = await fs.readFile(rearFirmwarePath);

        // 3. Update main board first (furthest from computer)
        console.log('[FIRMWARE] Starting main board update...');
        const mainResponse = await uploadFirmware(deviceIp, mainFirmware, true);
        if (!mainResponse.ok) {
            throw new Error(`Main board firmware upload failed: ${mainResponse.status}`);
        }

        // 4. Wait for main board firmware to be processed (7 seconds in app)
        console.log('[FIRMWARE] Waiting for main board firmware processing...');
        await new Promise(resolve => setTimeout(resolve, CONFIG.FIRMWARE_PROCESSING_WAIT));

        // 5. Reboot main board
        console.log('[FIRMWARE] Rebooting main board...');
        const mainRebootResponse = await rebootDevice(deviceIp, 'main');
        if (!mainRebootResponse.ok) {
            throw new Error(`Main board reboot failed: ${mainRebootResponse.status}`);
        }

        // 6. Short wait for reboot message to propagate (1.5s in app)
        console.log('[FIRMWARE] Waiting for reboot message to propagate...');
        await new Promise(resolve => setTimeout(resolve, CONFIG.SEND_REBOOT_WAIT));

        // 7. Immediately proceed with rear board update
        console.log('[FIRMWARE] Starting rear board update...');
        const rearResponse = await uploadFirmware(deviceIp, rearFirmware, false);
        if (!rearResponse.ok) {
            throw new Error(`Rear board firmware upload failed: ${rearResponse.status}`);
        }

        // 8. Wait for rear board firmware to be processed (7s in app)
        console.log('[FIRMWARE] Waiting for rear board firmware processing...');
        await new Promise(resolve => setTimeout(resolve, CONFIG.FIRMWARE_PROCESSING_WAIT));

        // 9. Reboot rear board
        console.log('[FIRMWARE] Rebooting rear board...');
        const rearRebootResponse = await rebootDevice(deviceIp, 'rear');
        if (!rearRebootResponse.ok) {
            throw new Error(`Rear board reboot failed: ${rearRebootResponse.status}`);
        }

        // 10. Wait for rear board to fully reboot (20s in app)
        console.log('[FIRMWARE] Waiting for rear board to complete reboot...');
        await new Promise(resolve => setTimeout(resolve, CONFIG.REAR_BOARD_REBOOT_WAIT));

        console.log('[FIRMWARE] Firmware update completed successfully!');
        
        // Try to get new version
        try {
            const newDeviceInfo = await getDeviceInfo(deviceIp);
            console.log(`[FIRMWARE] New firmware version: ${newDeviceInfo.firmwareVersion}`);
        } catch (error) {
            console.log('[FIRMWARE] Device still rebooting, cannot get new firmware version yet');
        }

    } catch (error) {
        console.error('[FIRMWARE] Update failed:', error.message);
        throw error;
    }
}

// Command line interface
if (require.main === module) {
    (async () => {
        const args = process.argv.slice(2);
        const targetIp = args[0] || '10.110.73.155';  // Default to office charger IP

        try {
            // Find firmware files
            const firmwareFiles = await findLatestFirmwareFiles();
            
            console.log(`[FIRMWARE] Firmware files validated:`);
            console.log(`[FIRMWARE] Main firmware: ${path.basename(firmwareFiles.main)}`);
            console.log(`[FIRMWARE] Rear firmware: ${path.basename(firmwareFiles.rear)}`);
            
            // Test connection to device
            console.log(`[DISCOVERY] Testing connection to device at ${targetIp}...`);
            const deviceInfo = await testDeviceConnection(targetIp);
            if (!deviceInfo) {
                console.error(`[DISCOVERY] Failed to connect to device at ${targetIp}`);
                console.error('Make sure the device is powered on and accessible at this IP address');
                process.exit(1);
            }
            
            console.log(`[DISCOVERY] Successfully connected to device: ${deviceInfo.deviceName} at ${targetIp}`);
            
            // Execute update
            console.log(`\n[FIRMWARE] Starting update for device: ${deviceInfo.deviceName} at ${targetIp}`);
            await executeFirmwareUpdate(targetIp, firmwareFiles.main, firmwareFiles.rear);
            console.log(`[FIRMWARE] Successfully updated device: ${deviceInfo.deviceName} at ${targetIp}`);
            console.log('\n[FIRMWARE] Update process completed');
            
        } catch (error) {
            console.error('[FIRMWARE] Error:', error.message);
            process.exit(1);
        }
    })();
}
