#include <node_api.h>
#include <sys/file.h>
#include <errno.h>
#include <string.h>
#ifdef __APPLE__
#include <sys/sysctl.h>
#include <stdlib.h>
#endif

static napi_value change(napi_env env, napi_callback_info info, int operation) {
  size_t argc = 1;
  napi_value argv[1], result;
  int32_t fd;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_int32(env, argv[0], &fd) != napi_ok || fd < 0) {
    napi_throw_type_error(env, "TX_LOCK_ARGUMENT", "Expected an open lock descriptor");
    return NULL;
  }
  if (flock(fd, operation) != 0) {
    if ((operation & LOCK_NB) && (errno == EWOULDBLOCK || errno == EAGAIN)) {
      napi_get_boolean(env, 0, &result);
      return result;
    }
    napi_throw_error(env, "TX_LOCK_FAILED", strerror(errno));
    return NULL;
  }
  napi_get_boolean(env, 1, &result);
  return result;
}
static napi_value acquire(napi_env env, napi_callback_info info) { return change(env, info, LOCK_EX | LOCK_NB); }
static napi_value release(napi_env env, napi_callback_info info) { return change(env, info, LOCK_UN); }
/* Kernel process arguments avoid spawning ps while holding a Mission lock. */
static napi_value process_args(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_get_null(env, &result);
#ifdef __APPLE__
  size_t argc = 1;
  napi_value argv[1];
  int32_t pid;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_int32(env, argv[0], &pid) != napi_ok || pid <= 0) return result;
  int limit = 0, limit_mib[] = { CTL_KERN, KERN_ARGMAX };
  size_t length = sizeof(limit);
  if (sysctl(limit_mib, 2, &limit, &length, NULL, 0) != 0 || limit <= 0 || limit > 16 * 1024 * 1024) return result;
  char *buffer = malloc((size_t)limit);
  if (!buffer) return result;
  int mib[] = { CTL_KERN, KERN_PROCARGS2, pid };
  length = (size_t)limit;
  if (sysctl(mib, 3, buffer, &length, NULL, 0) != 0 || length < sizeof(int)) { free(buffer); return result; }
  int count;
  memcpy(&count, buffer, sizeof(count));
  char *cursor = buffer + sizeof(count), *end = buffer + length;
  while (cursor < end && *cursor) cursor++;
  while (cursor < end && !*cursor) cursor++;
  napi_value list;
  napi_create_array(env, &list);
  int valid = count > 0;
  for (int i = 0; i < count; i++) {
    char *arg = cursor;
    while (cursor < end && *cursor) cursor++;
    if (cursor == end) { valid = 0; break; }
    napi_value value;
    napi_create_string_utf8(env, arg, (size_t)(cursor - arg), &value);
    napi_set_element(env, list, (uint32_t)i, value);
    cursor++;
  }
  if (valid) result = list;
  free(buffer);
#else
  (void)info;
#endif
  return result;
}
NAPI_MODULE_INIT() {
  napi_property_descriptor methods[] = {
    { "acquire", NULL, acquire, NULL, NULL, NULL, napi_default, NULL },
    { "release", NULL, release, NULL, NULL, NULL, napi_default, NULL },
    { "processArgs", NULL, process_args, NULL, NULL, NULL, napi_default, NULL }
  };
  napi_define_properties(env, exports, 3, methods);
  return exports;
}
