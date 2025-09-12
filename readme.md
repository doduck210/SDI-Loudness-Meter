# How to compile & run
``` bash
make
./Capture -d 0 -m 11
```
-h for further instruction  
briefly,  
-d option is to select device  
-m is selecting fps. -1 is autodetect.  


### SDI signal info
* Audio : 48Khz pcm_s24le
* Video : 59.94i 1920x1080 (not used tho)    
tested with SBS MCR PGM signal

### My Environment
* decklink driver : desktopvideo 14.4.1a4 
* ubuntu 22.04.5 LTS
* cpu : 12th Gen Intel(R) Core(TM) i5-12600H
* ram : 16 GB

