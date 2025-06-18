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
cd /home/<USER>
git clone https://github.com/rmiessle/libcal-api.git
cd libcal-api
cp .env.example .env                              # or create by hand
nano .env                                         # fill LIBCAL_* creds and hours
npm init -y                                       # creates package.json
npm install express node-fetch@2 dotenv dayjs     # installs runtime dependencies
npm start
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
WorkingDirectory=/home/<USER>/libcal-api
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
##### use X11
```
sudo raspi-config    # select option A6 and revert to X11
```
##### create script to disable blanking and screensaver
```
sudo nano /home/<USER>/dpms_disable.sh
```
###### append
```
#!/bin/bash 
export DISPLAY=:0 
xset s noblank 
xset s off 
xset -dpms
```
###### set permissions
```
chmod +x /home/USER/dpms_disable.sh
```
##### install unclutter-xfixes
```
sudo apt update
sudo apt install unclutter-xfixes
```
##### configure autostart
```
sudo nano /etc/xdg/lxsession/LXDE-pi/autostart
```
###### append
```
@lxpanel --profile LXDE-pi 
@pcamfm --desktop --profile LXDE-pi 
@/home/<USER>/dpms_disable.sh 
@unclutter-xfixes -idle 0
@sed -i 's/"exited_cleanly":false/"exited_cleanly":true/' /home/<USER>/.config/chromium/Default/Preferences 
@sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/' /home/<USER>/.config/chromium/Default/Preferences 
@chromium --noerrdialogs --disable-infobars --incognito --no-first-start --kiosk http://localhost:4000
```
##### screen blanking script when closed
###### create script
```
sudo nano ~/blank_screen.sh
```
###### append
```
#!/bin/bash 
sleep 5 
pkill chromium 
sleep 5 
export DISPLAY=:0 
xhost +local: 
xset +dpms 
xset dpms force off
```
###### set permissions
```
chmod +x ~/blank_screen.sh 
```
##### set up crontab
```
crontab -e
```
###### append
```
###Semester hours 
##reboot at 0755 
55 07 * * * pkill chromium; sleep 15; sudo reboot
##turn off display at 0100 
00 01 * * * /home/USER/blank_screen.sh 
###Summer hours 
##reboot at 0855 Monday-Friday 
#55 08 * * 1-5 pkill chromium; sleep 15; sudo reboot 
##turn off display at 1630 Monday-Friday 
#30 16 * * 1-5 /home/<USER>/blank_screen.sh
```
##### start menu shortcut to kill kiosk
```
sudo nano ~/.local/share/applications/shutdown-kiosk.desktop
```
###### append
```
[Desktop Entry] 
Name=Shutdown Kiosk 
Comment=Shuts down Chromium Browser Kiosk 
Exec=pkill chromium 
Icon=utilities-terminal 
Terminal=false 
Type=Application 
Categories=Utility;
```
###### set permissions
```
chmod +x ~/.local/share/applications/shutdown-kiosk.desktop
```
##### start menu shortcut to restart kiosk
###### create script
```
sudo nano ~/restart-kiosk.sh
```
###### append
```
#!/bin/bash 
export DISPLAY=:0 
xset s noblank 
xset s off 
xset -dpms 
@unclutter-xfixes -idle 0
@sed -i 's/"exited_cleanly":false/"exited_cleanly":true/' /home/<USER>/.config/chromium/Default/Preferences 
@sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/' /home/<USER>/.config/chromium/Default/Preferences 
@chromium --noerrdialogs --disable-infobars --incognito --no-first-start --kiosk http://localhost:4000
```
###### set permissions
```
chmod +x ~/restart-kiosk.sh
```
###### create shortcut
```
sudo nano ~/.local/share/applications/restart-kiosk.desktop
```
###### append
```
[Desktop Entry] 
Name=Restart Kiosk 
Comment=Restarts Chromium Browser Kiosk 
Exec=/home/USER/restart-kiosk.sh 
Icon=utilities-terminal 
Terminal=false 
Type=Application 
Categories=Utility; 
```
###### set permissions
```
chmod +x ~/.local/share/applications/restart-kiosk.desktop
```
### Lockdown and update
1. Auto-update: ```git -C /home/pi/libcal-room-board pull``` cron job nightly/weekly
2. Prevent package prompts: ```sudo apt install unattended-upgrades``` and disable “update notifier” GUI service
3. Sync time: 	Verify with ```timedatectl```
### Maintenance
1. Check logs: ```journalctl -u libcal-board -f```
2. Restart service: ```sudo systemctl restart libcal-board```
3. Upgrade dependencies: ```cd ~/libcal-room-board && git pull && npm ci && sudo systemctl restart libcal-board```


