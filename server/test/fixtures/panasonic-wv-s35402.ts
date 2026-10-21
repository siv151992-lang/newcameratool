/**
 * Real replies from a Panasonic / i-PRO WV-S35402-F2L (firmware 3.50, s32302), captured 2026-10-21.
 * GETINFO is the complete /cgi-bin/getinfo?FILE=1 reply. SDCARD_PAGE is an excerpt of
 * /admin/setup_sdcard.html?Language=0 (92 kB): the lines that carry the SD card figures and how the
 * page displays them, in their original order.
 */
export const WV_S35402_GETINFO = `<HTML>
MAC=D4-2D-C5-83-D8-51
SERIAL=YLA09673
VERSION=3.50
NAME=WV-S35402-F2L
SDrec=on
sAlarm=OFF
sAUX=off
ePort=31004
aEnable=in
aEnc=2
ImageCaptureMode=4m
ratio=16_9
Maxfps=30
StreamMode=1
iBitrate_h264=2048
iResolution_h264=2560
PRODUCT_NAME=WV-S35402-F2L
DESTINATION=P
EXTAPP1=AI-VMD
PRODUCT_NAME_ALT=WV-S25500-V3L
BROWSER=2
FIRMWARE=s32302
</HTML>
`.replace(/\n/g, "\r\n");

export const WV_S35402_SDCARD_PAGE = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">
<html><head><script type="text/javascript">
var gCamstatus = 0;
var giUseSd2 = 0;
var gsSdMode = "sdrec";
var sRemSD = "696";
var sTotalSD = "243952";
var sRemSD2 = "-";
var sTotalSD2 = "-";
var gbEasyStatus = false;
var iRemain = 50;
function SDcardStatus()
{
var sd1 = document.getElementsByName('sdcard')[0].checked;
var sRemSDplus = 0;
var sRemSDview = "";
var sTotalSDplus = 0;
var sd1Total = 0;
var sd2Total = 0;
if ( ((sRemSD == "-")||(sRemSD == "")||(sRemSD == "-"))||(sd1==false) )
sRemSDview = "----------MB";
else if ( sRemSD == "#" )
sRemSDview = "##########MB";
else if ( sRemSD == "*" )
sRemSDview = "**********MB";
else
sRemSDview = parseInt( sRemSD, 10 ) + "MB";
sTotalSDview = parseInt( sTotalSD, 10 ) + "MB";
this.tdSdInfo.innerHTML = sRemSDview + "/" + sTotalSDview + "(Remaining capacity/Original capacity)";
}
</script></head><body></body></html>
`;
