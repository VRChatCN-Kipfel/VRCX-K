use std::io;
use std::process::{Child, ChildStdin, ChildStdout, Command, ExitStatus};

pub struct ProcessTree {
    child: Child,
    #[cfg(windows)]
    job: Option<win::Job>,
}

impl ProcessTree {
    pub fn spawn(cmd: &mut Command) -> io::Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let child = cmd.spawn()?;
        #[cfg(windows)]
        {
            let job = win::Job::create()
                .ok()
                .and_then(|job| job.assign(&child).ok().map(|()| job));
            return Ok(Self { child, job });
        }
        #[cfg(not(windows))]
        Ok(Self { child })
    }

    #[allow(dead_code)]
    pub fn id(&self) -> u32 {
        self.child.id()
    }

    pub fn child_stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout.take()
    }

    pub fn child_stdin(&mut self) -> Option<ChildStdin> {
        self.child.stdin.take()
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    #[allow(dead_code)]
    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        self.child.wait()
    }

    pub fn kill_tree(&mut self) {
        #[cfg(windows)]
        {
            if let Some(job) = self.job.take() {
                job.terminate();
            } else {
                let _ = Command::new("taskkill")
                    .args(["/T", "/F", "/PID", &self.child.id().to_string()])
                    .status();
            }
        }
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.child.id() as i32), libc::SIGKILL);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            self.kill_tree();
        }
    }
}

#[allow(dead_code)]
pub fn pid_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        win::pid_alive(pid)
    }
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
}

#[cfg(windows)]
mod win {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    type Handle = *mut core::ffi::c_void;

    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;

    #[repr(C)]
    struct JobObjectBasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    struct JobObjectExtendedLimitInformation {
        basic_limit_information: JobObjectBasicLimitInformation,
        io_info: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attrs: *const core::ffi::c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            kind: i32,
            info: *const core::ffi::c_void,
            len: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn TerminateJobObject(job: Handle, exit_code: u32) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn GetExitCodeProcess(process: Handle, code: *mut u32) -> i32;
    }

    pub struct Job(Handle);

    // SAFETY: a Windows HANDLE is a raw pointer with no thread affinity. The
    // only owner-side operation is `terminate`/`CloseHandle` in Drop, which is
    // thread-safe (kernel objects are process-global). Transferring the Job
    // between threads (e.g. HostState inside a Mutex) is sound.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn create() -> Result<Self, ()> {
            unsafe {
                let handle = CreateJobObjectW(core::ptr::null(), core::ptr::null());
                if handle.is_null() {
                    return Err(());
                }
                let mut info: JobObjectExtendedLimitInformation = std::mem::zeroed();
                info.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    handle,
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                    (&info as *const JobObjectExtendedLimitInformation).cast(),
                    std::mem::size_of::<JobObjectExtendedLimitInformation>() as u32,
                );
                if ok == 0 {
                    CloseHandle(handle);
                    return Err(());
                }
                Ok(Self(handle))
            }
        }

        pub fn assign(&self, child: &Child) -> Result<(), ()> {
            let process = child.as_raw_handle() as Handle;
            let ok = unsafe { AssignProcessToJobObject(self.0, process) };
            if ok == 0 {
                Err(())
            } else {
                Ok(())
            }
        }

        pub fn terminate(self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    pub fn pid_alive(pid: u32) -> bool {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let mut code = 0u32;
            let ok = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            ok != 0 && code == STILL_ACTIVE
        }
    }
}
