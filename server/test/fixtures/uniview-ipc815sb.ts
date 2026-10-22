/** Replies from a real Uniview IPC815SB-ADF14K-I0 (firmware GIPC-B6203.15.6.241115) with a 256 GB SD card. */

/** GET /LAPI/V1.0/Storage/Containers/DetailInfos */
export const IPC815SB_CONTAINERS = `{
"Response": {
	"ResponseURL": "/LAPI/V1.0/Storage/Containers/DetailInfos",
	"CreatedID": -1,
	"ResponseCode": 0,
	"SubResponseCode": 0,
	"ResponseString": "Succeed",
	"StatusCode": 0,
	"StatusString": "Succeed",
	"Data": {
	"LocalHDDNum":	0,
	"LocalHDDList":	[],
	"SDNum":	1,
	"SDList":	[{
			"ID":	1,
			"RemainCapacity":	37298,
			"TotalCapacity":	243712,
			"Manufacturer":	"",
			"Status":	3,
			"Property":	0,
			"FormatProgress":	0,
			"GroupID":	0
		}],
	"ArrayNum":	0,
	"ArrayList":	[],
	"ExtendCabinet1HDDNum":	0,
	"ExtendCabinet1HDDList":	[],
	"ExtendCabinet2HDDNum":	0,
	"ExtendCabinet2HDDList":	[],
	"NASNum":	0,
	"NASList":	[],
	"eSATANum":	0,
	"eSATAList":	[],
	"IPSANNum":	0,
	"IPSANList":	[]
	}
	}
}`;

/** GET /LAPI/V1.0/Storage/Disks, /Storage/Status and other paths this model does not provide. */
export const ipc815sbNotSupported = (url: string) => `{
"Response": {
	"ResponseURL": "${url}",
	"CreatedID": -1,
	"ResponseCode": 4,
	"SubResponseCode": 0,
	"ResponseString": "Not Supported",
	"StatusCode": 8,
	"StatusString": "UnSupport",
	"Data": "null"
	}
}`;
