// stdin is a duplicate of the accepted Unix socket, inherited from Electron.
#define _GNU_SOURCE
#include <stdio.h>
#include <sys/socket.h>
#include <sys/types.h>
#ifdef __APPLE__
#include <sys/un.h>
#endif

int main(void) {
    pid_t pid;
#ifdef __APPLE__
    socklen_t size = sizeof(pid);
    if (getsockopt(0, SOL_LOCAL, LOCAL_PEERPID, &pid, &size) != 0) return 1;
#else
    struct ucred peer;
    socklen_t size = sizeof(peer);
    if (getsockopt(0, SOL_SOCKET, SO_PEERCRED, &peer, &size) != 0) return 1;
    pid = peer.pid;
#endif
    if (pid <= 0) return 1;
    printf("%ld\n", (long)pid);
    return 0;
}
