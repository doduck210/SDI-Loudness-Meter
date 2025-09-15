# How to compile & run

### requirements
``` shell
# ffmpeg libraries for graphs
sudo apt-get install libavformat-dev libavfilter-dev libavdevice-dev libavutil-dev
```
* decklink driver (desktop video)

``` bash
make
./Capture -d 0 -m 11
```
-h for further instruction  
briefly,  
-d option is to select device  
-m is selecting fps. -1 is autodetect.  
   
To use Web GUI Interface : 
``` bash
npm install
node server.js
```
http://localhost:8080  


### SDI signal info
* Audio : 48Khz pcm_s24le
* Video : 59.94i 1920x1080 (not used tho)    
tested with SBS MCR PGM signal

### My Environment
* decklink driver : desktopvideo 14.4.1a4 
* ubuntu 22.04.5 LTS
* cpu : 12th Gen Intel(R) Core(TM) i5-12600H
* ram : 16 GB

