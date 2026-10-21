/**
 * Replies from a real DS-2CD3563G2-IS (recording continuously to its SD card). The camera's
 * address is replaced with a documentation address.
 */

/** GET /ISAPI/ContentMgmt/Recording/status: not provided by this camera. */
export const DS2CD3563G2_RECORDING_STATUS_404 = `<!DOCTYPE html>
<html><head><title>Document Error: Not Found</title></head>
<body><h2>Access Error: 404 -- Not Found</h2>
<p>Can't find process for service:/ISAPI/ContentMgmt/Recording/status</p>
</body>
</html>`;

const action = (day: string) => `<ScheduleAction>
<id>1</id>
<ScheduleActionStartTime>
<DayOfWeek>${day}</DayOfWeek>
<TimeOfDay>00:00:00</TimeOfDay>
</ScheduleActionStartTime>
<ScheduleActionEndTime>
<DayOfWeek>${day}</DayOfWeek>
<TimeOfDay>24:00:00</TimeOfDay>
</ScheduleActionEndTime>
<ScheduleDSTEnable>false</ScheduleDSTEnable>
<Description>nothing</Description>
<Actions>
<Record>true</Record>
<ActionRecordingMode>CMR</ActionRecordingMode>
</Actions>
</ScheduleAction>`;

/** GET /ISAPI/ContentMgmt/record/tracks/101: continuous recording all week. */
export const DS2CD3563G2_TRACK = (enable = "true") => `<?xml version="1.0" encoding="UTF-8"?>
<Track version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<id>101</id>
<Channel>101</Channel>
<Enable>${enable}</Enable>
<Description>trackType=standard,trackType=video,codecType=H.264-BP,resolution=1920x1080,framerate=0.880000 fps,bitrate=200 kbps</Description>
<TrackGUID>e32e6863-ea5e-4ee4-997e-e0ca3c91248a</TrackGUID>
<DefaultRecordingMode>CMR</DefaultRecordingMode>
<LoopEnable>true</LoopEnable>
<SrcDescriptor>
<SrcGUID>e32e6863-ea5e-4ee4-997e-e0ca3c91248a</SrcGUID>
<SrcChannel>1</SrcChannel>
<SrcDriver>RTSP</SrcDriver>
<SrcType>H.264-BP</SrcType>
<SrcUrl>rtsp://localhost/ISAPI/Streaming/channels/101</SrcUrl>
<SrcLogin>admin</SrcLogin>
</SrcDescriptor>
<TrackSchedule>
<ScheduleBlockList>
<ScheduleBlock ScheduleActionSize="8" >
<ScheduleBlockGUID>{00000000-0000-0000-0000-000000000000}</ScheduleBlockGUID>
<ScheduleBlockType>www.hikvision.com/racm/schedule/ver10</ScheduleBlockType>
${["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map(action).join("\n")}
</ScheduleBlock>
</ScheduleBlockList>
</TrackSchedule>
</Track>`;

const item = (start: string, end: string, size: number) => `<searchMatchItem>
<sourceID>{0000000000-0000-0000-0000-000000000000}</sourceID>
<trackID>101</trackID>
<timeSpan>
<startTime>${start}</startTime>
<endTime>${end}</endTime>
</timeSpan>
<mediaSegmentDescriptor>
<contentType>video</contentType>
<codecType>H.264-BP</codecType>
<playbackURI>rtsp://192.0.2.10/Streaming/tracks/101/?starttime=${start.replace(/[-:]/g, "")}&amp;endtime=${end.replace(/[-:]/g, "")}&amp;name=ch01_00000000290000000&amp;size=${size}</playbackURI>
</mediaSegmentDescriptor>
<metadataMatches>
<metadataDescriptor>recordType.meta.hikvision.com/timing</metadataDescriptor>
</metadataMatches>
</searchMatchItem>`;

/** POST /ISAPI/ContentMgmt/search for today: three segments, the last one still being written. */
export const DS2CD3563G2_SEARCH = `<?xml version="1.0" encoding="UTF-8"?>
<CMSearchResult version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<searchID>{C0000000-0000-0000-0000-000000000001}</searchID>
<responseStatus>true</responseStatus>
<responseStatusStrg>OK</responseStatusStrg>
<totalMatches>3</totalMatches>
<numOfMatches>3</numOfMatches>
<matchList>
${item("2026-10-20T19:56:02Z", "2026-10-21T03:30:54Z", 260128768)}
${item("2026-10-21T03:30:54Z", "2026-10-21T11:08:34Z", 260145152)}
${item("2026-10-21T11:08:34Z", "2026-10-21T13:22:18Z", 142393344)}
</matchList>
</CMSearchResult>`;

/** A search with no recordings in the requested period. */
export const SEARCH_NO_MATCHES = `<?xml version="1.0" encoding="UTF-8"?>
<CMSearchResult version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<searchID>{C0000000-0000-0000-0000-000000000001}</searchID>
<responseStatus>false</responseStatus>
<responseStatusStrg>NO MATCHES</responseStatusStrg>
<numOfMatches>0</numOfMatches>
</CMSearchResult>`;

export const cameraTime = (local: string) => `<?xml version="1.0" encoding="UTF-8"?>
<Time version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<timeMode>NTP</timeMode>
<localTime>${local}</localTime>
<timeZone>CST-5:30:00</timeZone>
</Time>`;

/**
 * A DS-2CD2563G2-IS set to UTC+05:30 (camera time 2026-10-21T19:14:19+05:30) answers the same
 * search in real UTC: its segment being written ends at 13:42:42Z, i.e. 19:12:42 local time.
 */
export const DS2CD2563G2_SEARCH_UTC = `<?xml version="1.0" encoding="UTF-8"?>
<CMSearchResult version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<searchID>{C0000000-0000-0000-0000-000000000001}</searchID>
<responseStatus>true</responseStatus>
<responseStatusStrg>OK</responseStatusStrg>
<totalMatches>4</totalMatches>
<numOfMatches>4</numOfMatches>
<matchList>
${item("2026-10-20T20:18:27Z", "2026-10-21T01:17:32Z", 259932160)}
${item("2026-10-21T01:17:32Z", "2026-10-21T05:59:49Z", 260112384)}
${item("2026-10-21T05:59:49Z", "2026-10-21T10:16:08Z", 260014080)}
${item("2026-10-21T10:16:08Z", "2026-10-21T13:42:42Z", 174489600)}
</matchList>
</CMSearchResult>`;
