# Study Room Availability Site
Uses LibCal hours and spaces API

## RPi Deployment
### Configure RPi
1. Image RPi - https://www.raspberrypi.com/software/operating-systems/
2. Verify timezone is set
3. Install Chromium
### Install Node.js LTS
```
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs git
node -v   # should show e.g. v20.x
```
###  Deploy
```
cd /home/pi
git clone https://github.com/rmiessle/libcal-api.git
cd libcal-room-board
cp .env.example .env          # or create by hand
nano .env                     # fill LIBCAL_* creds and hours
npm ci                        # install exact package‑lock deps
```
### Run in background
Create systemd unit ```/etc/systemd/system/libcal-board.service```
#### ini
```
[Unit]
Description=LibCal study‑room board
After=network.target

[Service]
User=pi
WorkingDirectory=/home/pi/libcal-api
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```
#### bash
```
sudo systemctl daemon-reload
sudo systemctl enable --now libcal-board
sudo systemctl status libcal-board   # should say “active (running)”
```
### Configure Chromium Kiosk
#### Disable screen blanking
##### bash
```
sudo raspi-config nonint do_boot_behaviour B4    # desktop autologin
mkdir -p ~/.config/lxsession/LXDE-pi
nano ~/.config/lxsession/LXDE-pi/autostart
```
#### append
```
@xset s off           # never blank
@xset -dpms
@xset s noblank
@unclutter -idle 0    # hide mouse pointer
@chromium-browser --incognito --disable-translate --noerrdialogs \
    --kiosk http://localhost:4000
```
### Lockdown and update
1. Auto-update: ```git -C /home/pi/libcal-room-board pull``` cron job nightly/weekly
2. Prevent package prompts: ```sudo apt install unattended-upgrades``` and disable “update notifier” GUI service
3. Sync time: 	Verify with ```timedatectl```
### Maintenance
1. Check logs: ```journalctl -u libcal-board -f```
2. Restart service: ```sudo systemctl restart libcal-board```
3. Upgrade dependencies: ```cd ~/libcal-room-board && git pull && npm ci && sudo systemctl restart libcal-board```


