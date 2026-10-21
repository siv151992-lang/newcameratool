/** Real SUNAPI replies from a Hanwha QND-7012R (firmware unknown), captured 2026-10-21. Passwords were empty. */
export const QND7012R_STORAGEINFO = `UsedSpace=186445
TotalSpace=239155

Storage.1.Type=DAS
Storage.1.UsedSpace=186445
Storage.1.TotalSpace=239155
Storage.1.FileSystem=ext4
Storage.1.Enable=True
Storage.1.Status=Active
Storage.1.IsDASEncryptEnable=False
Storage.1.DASPassword=
Storage.1.IsSDCardEncrypted=False

Storage.2.Type=NAS
Storage.2.UsedSpace=0
Storage.2.TotalSpace=0
Storage.2.Enable=False
Storage.2.Status=
Storage.2.DefaultFolder=
Storage.2.NASIP=
Storage.2.NASUserID=
Storage.2.NASPassword=
Storage.2.IsPasswordSet=False
`.replace(/\n/g, "\r\n");

export const QND7012R_RECORDING_STORAGE = "Enable=True\r\nOverWrite=True\r\nAutoDeleteEnable=True\r\nAutoDeleteDays=180\r\n";

export const QND7012R_EVENTSTATUS = `AlarmInput.1=False
AlarmOutput.1=False
Channel.0.MotionDetection=False
Channel.0.MotionDetection.RegionID.1=False
Channel.0.Tampering=False
Channel.0.DefocusDetection=False
Channel.0.VideoAnalytics.Passing=False
Channel.0.VideoAnalytics.Intrusion=False
Channel.0.VideoAnalytics.Entering=False
Channel.0.VideoAnalytics.Exiting=False
Channel.0.Connected=True
SystemEvent.TimeChange=False
SystemEvent.PowerReboot=False
SystemEvent.FWUpdate=False
SystemEvent.FactoryReset=False
SystemEvent.ConfigurationBackup=False
SystemEvent.ConfigurationRestore=False
SystemEvent.ConfigChange=False
SystemEvent.SDFormat=False
SystemEvent.SDFail=False
SystemEvent.SDFull=False
SystemEvent.SDInsert=True
SystemEvent.SDRemove=False
SystemEvent.NASConnect=False
SystemEvent.NASDisconnect=True
SystemEvent.NASFail=False
SystemEvent.NASFull=False
SystemEvent.NASFormat=False
`.replace(/\n/g, "\r\n");

/** storageinfo from another QND-7012R that has no SD card: the slot is enabled, status empty, size 0. */
export const QND7012R_NO_CARD_STORAGEINFO = `UsedSpace=0
TotalSpace=0

Storage.1.Type=DAS
Storage.1.UsedSpace=0
Storage.1.TotalSpace=0
Storage.1.FileSystem=ext4
Storage.1.Enable=True
Storage.1.Status=
Storage.1.IsDASEncryptEnable=False
Storage.1.DASPassword=
Storage.1.IsSDCardEncrypted=False

Storage.2.Type=NAS
Storage.2.UsedSpace=0
Storage.2.TotalSpace=0
Storage.2.Enable=False
Storage.2.Status=
Storage.2.DefaultFolder=
Storage.2.NASIP=
Storage.2.NASUserID=
Storage.2.NASPassword=
Storage.2.IsPasswordSet=False
`.replace(/\n/g, "\r\n");
